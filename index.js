import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

export const name = 'context-cleaner'
export const inject = ['webServer', 'sessions', 'tools']

// apply 里拿到宿主的 sessions API（跟聊桥插件用的是同一套 RPC），拿到就能真正把话塞进会话里跑
let 会话API = null
let 会话控 = null
let 宿主ctx = null

const 家 = os.homedir()
// 备份、日志、校验器都放这里；要换位置设 CONTEXT_CLEANER_HOME
const 数据根 = process.env.CONTEXT_CLEANER_HOME || path.join(家, '.dsh', 'context-cleaner')
const 会话根 = path.join(家, '.dsh', 'sessions')
const 投影根 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions')
const 备份根 = path.join(数据根, 'context-cleaner-backups')
const 日志文件 = path.join(数据根, 'context-cleaner.log')
// billion-context 的账库；非默认安装位置设 BILLION_CONTEXT_DIR
// 宿主自带的会话格式校验器是可选的：找得到就校验，找不到就只告警（可用 DSH_PERSIST_WORKER 指定）
const 校验器 = [
  process.env.DSH_PERSIST_WORKER,
  path.join(数据根, 'persist-verify', 'lib', 'worker.cjs'),
  process.env.DSH_ROOT &&
    path.join(process.env.DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'worker.cjs'),
].find((p) => p && fs.existsSync(p)) || ''
const 每帧行数 = 400
// 同类注入保留最近几份，更早的折叠成一行占位：5 份能兜住「旧记忆快照被压缩过」「只出现一次的系统指令」两处损失
export let 保留份数 = 5
export function 设保留份数(n) {
  const v = Number(n)
  if (Number.isFinite(v) && v >= 1 && v <= 50) 保留份数 = Math.floor(v)
  return 保留份数
}

// 骨架事件：清掉内容时仍要留下，宿主靠它们配对 turn/step
const 骨架 = new Set(['turn/start', 'step/start', 'step/end', 'turn/end'])
// 表面事件：内容被删掉的这些要改成 append，且不能带跨记录坐标
const 表面 = new Set(['user/message', 'assistant/message', 'system/message', 'tool/result'])
const 工具类 = new Set(['tool/call', 'tool/result'])
const 带坐标字段 = ['sourceEventSeqs', 'surfaceOp', 'messageSeqs', 'sourceEventSeq']

function 读会话(文件) {
  const 读一遍 = () => {
    const 原 = fs.readFileSync(文件)
    const 文 = 读全文(原)
    const 行 = 文.split('\n').filter(Boolean)
    return { 原, 文, 行 }
  }
  let 次 = 读一遍()
  // 只解出表头一行 = 文件此刻只有表头帧（宿主正在重写），稍等再读一次
  for (let i = 0; i < 3 && 次.行.length <= 1; i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    次 = 读一遍()
  }
  if (次.行.length <= 1) {
    throw new Error(
      `会话日志里只有表头、没有事件（文件 ${次.原.length} 字节，解压后 ${次.文.length} 字节）：${path.basename(path.dirname(文件))}`,
    )
  }
  return { 头: JSON.parse(次.行[0]), 体: 次.行.slice(1).map((l) => JSON.parse(l)) }
}

function 文本(message) {
  if (!message || typeof message !== 'object') return ''
  const 块 = Array.isArray(message.content) ? message.content : []
  return 块.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

function 摘要(text) {
  const 干 = String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\[系统提醒\][\s\S]*/, '')
    .replace(/<dsh_im_source>[\s\S]*?<\/dsh_im_source>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return 干.length > 34 ? 干.slice(0, 34) + '…' : 干
}

function 字时(ms) {
  const d = new Date(ms)
  const 补 = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}`
}

// 按「时间空档」把会话切成若干工作段：空档超过 90 分钟就断开
function 分段(体, 空档分钟 = 90) {
  const 段 = []
  let 当前 = null
  for (const e of 体) {
    const t = typeof e.time === 'number' ? e.time : 0
    if (!当前 || (t && 当前.到 && t - 当前.到 > 空档分钟 * 60000)) {
      当前 = { 起: t, 到: t, 事件: [], 首句: '', 用户消息: 0, 工具: 0 }
      段.push(当前)
    }
    当前.到 = Math.max(当前.到, t)
    当前.事件.push(e)
    if (e.type === 'user/message') {
      当前.用户消息 += 1
      const 句 = 摘要(文本(e.data))
      // 跳过身份注入、system-reminder、定时提醒这类「不是人说的话」的块，否则首句全是 ［身份］你是…
      if (
        !当前.首句 &&
        句 &&
        !/^([[<［]|人设依据|Current runtime context|MNEMON|Time sampled|Instructions from:|You are |# )/.test(句)
      )
        当前.首句 = 句
    }
    if (e.type === 'tool/call') 当前.工具 += 1
  }
  return 段.filter((s) => s.事件.length > 0)
}

// 只数「会进模型上下文」的正文：文本块字符数（中文约 1 字 ≈ 1 token）。data.stream 不算。
function 正文字数(e) {
  if (!e || typeof e !== 'object') return 0
  const 消息 = e.type === 'user/message' ? e.data : e.type === 'assistant/message' ? e.data?.message : e.type === 'tool/result' ? e.data?.message : null
  let 数 = 0
  const 块 = Array.isArray(消息?.content) ? 消息.content : []
  for (const b of 块) {
    if (!b || typeof b !== 'object') continue
    if (typeof b.text === 'string') 数 += b.text.length
    else if (typeof b.thinking === 'string') 数 += b.thinking.length
    else if (b.type === 'tool_result' && typeof b.content === 'string') 数 += b.content.length
  }
  if (e.type === 'tool/call') 数 += JSON.stringify(e.data?.arguments ?? '').length
  return 数
}

function 估算(字节) {
  return Math.round(字节 / 3.4)
}

function 估算字(字数) {
  return Math.round(字数 * 0.85)
}

// 只解前几帧，拿「首句用户消息」当名字用——整份解压太慢
function 读头(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 起 = buf.readUInt32LE(0) === 0xfd2fb528 ? 0 : buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    if (起 < 0) return null
    const 第一行尾 = buf.indexOf(10, 起)
    const 帧 = zlib.zstdDecompressSync(buf.subarray(起, 第一行尾 + 1)).toString('utf8')
    return JSON.parse(帧.split('\n')[0])
  } catch {
    return null
  }
}

function 读首句(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = []
    let 起 = -1
    for (let i = 0; i + 4 <= buf.length && 帧.length < 4; i++) {
      if (buf.readUInt32LE(i) === 0xfd2fb528) {
        if (起 >= 0) 帧.push(buf.subarray(起, i))
        起 = i
      }
    }
    if (起 >= 0 && 帧.length < 4) 帧.push(buf.subarray(起))
    for (const f of 帧.slice(1, 4)) {
      let 帧文本 = ''
      try {
        帧文本 = zlib.zstdDecompressSync(f).toString('utf8')
      } catch {
        continue
      }
      for (const 行 of 帧文本.split('\n')) {
        if (!行.trim()) continue
        let e
        try {
          e = JSON.parse(行)
        } catch {
          continue
        }
        if (e.type !== 'user/message') continue
        const 句 = 摘要(文本(e.data))
        if (句) return 句.slice(0, 40)
      }
    }
  } catch {}
  return ''
}
function 读标题(id) {
  const 干净 = String(id).replace(/^session-/, '')
  try {
    const p = path.join(投影根, 干净 + '.json')
    if (fs.existsSync(p)) {
      const 行 = JSON.parse(fs.readFileSync(p, 'utf8'))?.record?.rows || {}
      for (const k of Object.keys(行)) {
        if (!/title/i.test(k)) continue
        const 值 = 行[k]
        const 候选 = typeof 值 === 'string' ? 值 : typeof 值?.val === 'string' ? 值.val : typeof 值?.val?.title === 'string' ? 值.val.title : ''
        if (候选) return 候选
      }
    }
  } catch {}
  return ''
}

// 宿主 sessionTitle 服务对标题的折叠规则就是「取最后一条 session/title 的 title」
// （dsh-session-title/lib/index.js 的 foldSessionTitle：events.findLast(type==='session/title')）
// 所以从文件末尾往回扫帧，命中即可停，不必整份解压
function 从文件读标题(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = 帧边界(buf)
    for (let k = 帧.length - 1; k >= 0; k--) {
      let 段
      try {
        段 = zlib.zstdDecompressSync(buf.subarray(帧[k][0], 帧[k][1])).toString('utf8')
      } catch {
        continue
      }
      const 行 = 段.split('\n').filter(Boolean)
      for (let j = 行.length - 1; j >= 0; j--) {
        let e
        try {
          e = JSON.parse(行[j])
        } catch {
          continue
        }
        if (e.type !== 'session/title') continue
        const t = e?.data?.title
        if (typeof t === 'string' && t.trim()) return t.trim()
      }
    }
  } catch {}
  return ''
}

// 侧栏面板上真的会显示哪些会话：宿主的 workspace.json 里每个工作区的 sessionIds
function 面板会话() {
  try {
    const p = path.join(家, '.dsh', 'storages', 'workspace.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const 表 = []
    const 见 = new Set()
    for (const w of Object.values(j?.tables?.workspaces || {})) {
      for (const id of w?.sessionIds || []) {
        const 干净 = String(id).replace(/^session-/, '')
        if (见.has(干净)) continue
        见.add(干净)
        表.push({ id: 干净, 工作区: String(w?.title || ''), 根: String(w?.path || '') })
      }
    }
    return 表
  } catch {
    return []
  }
}

// 目录名（--C-Users-xxx--）解回一个像路径的标签
function 解码根(名) {
  const 全 = String(名)
    .replace(/^--/, '')
    .replace(/--$/, '')
    .replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/-/g, '\\')
  return 全
}

function 短根(根) {
  const 段 = String(根).split('\\').filter(Boolean)
  // 编码时「C:\」被压成「C-」，盘符冒号丢了，这里按 Windows 形式拼回去再验存在
  const 拼 = (a) => `${a[0]}:\\${a.slice(1).join('\\')}`
  // 带连字符的真实目录名会被拆成几段，按磁盘上是否存在边拼边验
  const 全 = [`${段[0]}:`]
  for (let i = 1; i < 段.length; i++) {
    const 单独 = path.join(全[全.length - 1], 段[i])
    if (fs.existsSync(单独) || i + 1 >= 段.length) {
      全.push(单独)
    } else {
      全.push(path.join(全[全.length - 1], `${段[i]}-${段[i + 1]}`))
      i++
    }
  }
  return path.basename(全[全.length - 1]) || 根
}

// 解码根 是「C\Users\...」这种少冒号的形式，归一成 C:\Users\...
function 归一(根) {
  const s = String(根).replace(/[\\/]+$/, '')
  const m = /^([A-Za-z])\\(.*)$/.exec(s)
  return (m ? `${m[1]}:\\${m[2]}` : s).toLowerCase()
}

// 已经归档的会话（侧栏里收进「已归档」）。workspace.json 的 global.archivedSessionIds 是权威名单
function 归档集合() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(家, '.dsh', 'storages', 'workspace.json'), 'utf8'))
    const 集 = new Set()
    for (const id of j?.global?.archivedSessionIds || []) {
      if (id) 集.add(String(id))
    }
    return 集
  } catch {
    return new Set()
  }
}

function 列会话() {
  const 表 = []
  if (!fs.existsSync(会话根)) return 表
  const 面板表 = 面板会话()
  const 面板 = new Map(面板表.map((s) => [s.id, s.工作区]))
  // 已注册工作区的目录：这些目录下没进 sessionIds 的会话在侧栏里属于「未分组」
  const 注册根 = new Set(面板表.map((s) => String(s.根).toLowerCase().replace(/[\\/]+$/, '')).filter(Boolean))
  const 归档 = 归档集合()
  const 索引 = new Map()
  const 走 = (目录) => {
    for (const n of fs.readdirSync(目录, { withFileTypes: true })) {
      if (!n.isDirectory()) continue
      const p = path.join(目录, n.name)
      const f = path.join(p, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) 索引.set(n.name.replace(/^session-/, ''), { 文件: f, 根: 解码根(path.basename(目录)) })
      else 走(p)
    }
  }
  for (const n of fs.readdirSync(会话根, { withFileTypes: true })) {
    if (n.isDirectory()) 走(path.join(会话根, n.name))
  }

  for (const [id, 命中] of 索引) {
    if (归档.has(id) || 归档.has(`session-${id}`)) continue
    // 侧栏是按磁盘上的工作区目录列会话的，所以这里不按 sessionIds 白名单卡
    const 在面板 = 面板.has(id)
    const 头 = 读头(命中.文件)
    if (头 && (头.origin === 'subagent' || 头.parentSession)) continue
    // 空会话不显示（没聊过的占位）
    if (fs.statSync(命中.文件).size < 8192) continue
    const 标题 = 从文件读标题(命中.文件) || 读标题(id)
    // 插件自己的工人会话（mnemon 委派等）不进列表
    if (/^\[dsh-[^\]]+\]/.test(标题)) continue
    const 有账 = 有折叠账(id)
    // 占比优先用「上一次请求真实用掉的 token」（模型回报的 usage，就是实际发出去的大小）；
    // 没有 usage 才退到 ACP 账；ACP 的 stats 可能几小时不更新，直接信它会把在用会话显示成很小的数
    const 末用 = 读占用(命中.文件).token || 0
    const 账占 = 末用 || 账在用的tokens(id) || 0
    const 估 = Math.max(读占用(命中.文件).token, 估算tokens(命中.文件))
    const 占 = Math.min(窗口token, 账占 || 估)
    const st = fs.statSync(命中.文件)
    const 轮 = 读轮数(命中.文件)
    // 一条轮次都没有的文件（只剩表头、或还没真正开始聊）列出来也点不动，直接不收
    if (!轮) continue
    表.push({
      id,
      文件: 命中.文件,
      说明: 短根(命中.根),
      工作区: 面板.get(id) || 短根(命中.根),
      在面板,
      标题,
      首句: 标题 ? '' : 读首句(命中.文件),
      改动: st.mtimeMs,
      字节: st.size,
      占用: 占,
      占比: 占 ? Math.min(100, Math.max(1, Math.round((占 / 窗口token) * 100))) : 0,
      账算: !!账占,
      账token: 账占 || 0,
      初算: 估,
      轮数: 轮,
      折叠账: 有折叠账(id),
    })
  }
  // 侧栏里的排前面，同组按最近改的在前
  表.sort((a, b) => (Number(b.在面板) - Number(a.在面板)) || (b.改动 - a.改动))
  return 表
}

function 找会话(id) {
  const 干净 = String(id || '').replace(/^session-/, '')
  const hit = 列会话().find((s) => s.id === 干净 || s.id.startsWith(干净))
  if (!hit) throw new Error(`找不到会话 ${id}`)
  return hit
}

function 概要(文件) {
  const { 头, 体 } = 读会话(文件)
  const 标题 = 体.find((e) => e.type === 'session/title')?.data?.title || '(无标题)'
  const 轮 = 体.filter((e) => e.type === 'turn/start').length
  return {
    id: String(头?.id || '').replace(/^session-/, ''),
    标题: String(标题),
    轮,
    事件: 体.length,
    字节: fs.statSync(文件).size,
    改动: fs.statSync(文件).mtimeMs,
  }
}

// ── 上下文占用：只读最后一次请求的 usage，不解压整份文件 ──
const 窗口token = 1048576 // deepseek-flash 的实测有效窗口（宿主 413 报错里写的数）
const zstd魔 = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 一个 zstd 帧从 起 开始到哪结束（RFC 8878：帧头 + 块序列 + 可选校验和）
// 不能靠 indexOf 找魔数：压缩数据里也可能出现同样的 4 个字节
function 帧尾(buf, 起) {
  let i = 起 + 4
  if (i >= buf.length) return buf.length
  const fhd = buf[i]
  i += 1
  const fcs标 = fhd >> 6
  const 单段 = (fhd & 0x20) !== 0
  const 校验 = (fhd & 0x04) !== 0
  const 字典标 = fhd & 0x03
  if (!单段) i += 1 // window descriptor
  i += 字典标 === 3 ? 4 : 字典标
  i += fcs标 === 0 ? (单段 ? 1 : 0) : fcs标 === 1 ? 2 : fcs标 === 2 ? 4 : 8
  while (i + 3 <= buf.length) {
    const h = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)
    i += 3
    const 末块 = h & 1
    const 型 = (h >> 1) & 3
    const 长 = h >>> 3
    if (型 === 0) i += 长
    else if (型 === 1) i += 1
    else if (型 === 2) i += 长
    else return buf.length // 保留块类型，坏了
    if (末块) break
  }
  if (校验) i += 4
  return Math.min(i, buf.length)
}

function 帧边界(buf) {
  const 出 = []
  let i = 0
  while (i + 4 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0xfd2fb528) {
      const 下 = buf.indexOf(zstd魔, i + 1)
      if (下 < 0) break
      i = 下
      continue
    }
    const 尾 = 帧尾(buf, i)
    if (尾 <= i + 4) break
    出.push([i, 尾])
    i = 尾
  }
  return 出
}

// 多帧拼接的文件：整块 zstdDecompressSync 只会解第一帧，得逐帧解再拼起来
function 读全文(buf) {
  const 帧 = 帧边界(buf)
  if (帧.length > 1) {
    const 段 = 帧.map(([a, b]) => {
      try {
        return zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8')
      } catch {
        return ''
      }
    })
    const 合 = 段.join('')
    if (合.split('\n').filter(Boolean).length > 1) return 合
  }
  return zlib.zstdDecompressSync(buf).toString('utf8')
}

// 从最后一帧往回找带 usage 的 assistant/message
// 日志里最后一条 usage 是「当时」的占用，之后又追加了很多内容就不会更新了。
// 所以另算一个按正文字数的估算（中文约 1.6 字/token），两者取大，避免面板把爆掉的会话显示成 12%。
function 估算缓存路径() {
  return path.join(备份根, '估算.json')
}
function 估算tokens(文件) {
  let 键
  let st
  try {
    st = fs.statSync(文件)
    键 = path.basename(path.dirname(文件))
  } catch {
    return 0
  }
  let 缓 = {}
  try {
    缓 = JSON.parse(fs.readFileSync(估算缓存路径(), 'utf8')) || {}
  } catch {}
  const 旧 = 缓[键]
  if (旧 && 旧.m === st.mtimeMs && 旧.s === st.size) return 旧.t
  let 字 = 0
  try {
    const { 体 } = 读会话(文件)
    for (const e of 体) {
      if (e.type !== 'user/message' && e.type !== 'assistant/message' && e.type !== 'tool/result') continue
      const 瓶 = e.data && (e.data.message || e.data)
      const c = 瓶 && 瓶.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (!b || typeof b !== 'object') continue
        if (typeof b.text === 'string') 字 += b.text.length
        if (typeof b.thinking === 'string') 字 += b.thinking.length
      }
    }
  } catch {
    return 0
  }
  const t = Math.round(字 / 1.6)
  缓[键] = { m: st.mtimeMs, s: st.size, t, 字 }
  try {
    fs.mkdirSync(备份根, { recursive: true })
    fs.writeFileSync(估算缓存路径(), JSON.stringify(缓))
  } catch {}
  return t
}

function 读占用(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = 帧边界(buf)
    for (let k = 帧.length - 1; k >= 0; k--) {
      let 文本段
      try {
        文本段 = zlib.zstdDecompressSync(buf.subarray(帧[k][0], 帧[k][1])).toString('utf8')
      } catch {
        continue
      }
      const 行 = 文本段.split('\n').filter(Boolean)
      for (let j = 行.length - 1; j >= 0; j--) {
        let e
        try {
          e = JSON.parse(行[j])
        } catch {
          continue
        }
        const u = e?.data?.usage
        const 数 = Number(u?.totalTokens)
        if (Number.isFinite(数) && 数 > 0) return { token: 数, 窗口: 窗口token }
      }
    }
  } catch {}
  return { token: 0, 窗口: 窗口token }
}

// 从最后一帧往回找带 turn 的事件，拿到当前最大轮号（不必整份解压）
function 读轮数(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = 帧边界(buf)
    for (let k = 帧.length - 1; k >= 0; k--) {
      let 文本段
      try {
        文本段 = zlib.zstdDecompressSync(buf.subarray(帧[k][0], 帧[k][1])).toString('utf8')
      } catch {
        continue
      }
      const 行 = 文本段.split('\n').filter(Boolean)
      for (let j = 行.length - 1; j >= 0; j--) {
        let e
        try {
          e = JSON.parse(行[j])
        } catch {
          continue
        }
        const 轮 = Number(e?.data?.turn)
        if (Number.isFinite(轮) && 轮 > 0) return 轮
      }
    }
  } catch {}
  return 0
}

function 分析(id) {
  return 分析文件(找会话(id).文件)
}

// 段太多的时候（一次对话几千轮能切出三四十段），表就没法看了：
// 把相邻的小段并到一块，凑到最多 10 行，保留时间边界
function 合并段(清单, 上限 = 10) {
  if (清单.length <= 上限) return 清单
  const 每 = Math.ceil(清单.length / 上限)
  const 出 = []
  for (let i = 0; i < 清单.length; i += 每) {
    const 块 = 清单.slice(i, i + 每)
    if (!块.length) continue
    const 首 = 块[0]
    const 尾 = 块[块.length - 1]
    出.push({
      ...首,
      键: String(出.length),
      起: 首.起,
      止: 尾.止,
      起ms: 首.起ms,
      止ms: 尾.止ms,
      事件: 块.reduce((a, x) => a + x.事件, 0),
      轮: 块.reduce((a, x) => a + x.轮, 0),
      用户: 块.reduce((a, x) => a + x.用户, 0),
      工具: 块.reduce((a, x) => a + x.工具, 0),
      工具字: 块.reduce((a, x) => a + x.工具字, 0),
      对话字: 块.reduce((a, x) => a + x.对话字, 0),
      字节: 块.reduce((a, x) => a + x.字节, 0),
      字: 块.reduce((a, x) => a + x.字, 0),
      token: 块.reduce((a, x) => a + x.token, 0),
      占比: Math.round(块.reduce((a, x) => a + x.占比, 0) * 10) / 10,
      子: 块.flatMap((x) => (Array.isArray(x.子) && x.子.length ? x.子 : [[x.起ms, x.止ms]])),
      并了: 块.length,
    })
  }
  return 出
}

function 分析文件(文件) {
  const { 体 } = 读会话(文件)
  // 宿主正在重写会话文件时，zstd 里可能只有一个表头帧：读出来是空壳。
  // 这时切段必然是 0，别让上层把「切出了 0 段」当正常结果投出去。
  if (!体.length) throw new Error(`会话日志读出来是空的（0 条事件）：${path.basename(path.dirname(文件))}`)
  const 段 = 分段(体)
  const 总字节 = Buffer.byteLength(JSON.stringify(体))
  const 总字 = 体.reduce((a, e) => a + 正文字数(e), 0)
  const 工具字 = 体.reduce((a, e) => a + (工具类.has(e.type) ? 正文字数(e) : 0), 0)
  const 占用 = 读占用(文件)
  const 实测 = 占用.token || 0
  const 清单 = 段.map((s2, i) => {
    const 字节 = Buffer.byteLength(JSON.stringify(s2.事件))
    const 字 = s2.事件.reduce((a, e) => a + 正文字数(e), 0)
    const 本段工具字 = s2.事件.reduce((a, e) => a + (工具类.has(e.type) ? 正文字数(e) : 0), 0)
    const 名字 = [...new Set(s2.事件.filter((e) => e.type === 'tool/call').map((e) => String(e.data?.name || '')))].filter(Boolean)
    // 体积按「实测占用 × 本段在全文里的字节占比」算，这样各段加起来正好等于真实占用
    const 占比 = 总字节 ? 字节 / 总字节 : 0
    return {
      键: String(i),
      标题: s2.首句 || '(无正文)',
      起: 字时(s2.起),
      止: 字时(s2.到),
      起ms: s2.起,
      止ms: s2.到,
      事件: s2.事件.length,
      轮: s2.事件.filter((e) => e.type === 'turn/start').length,
      用户: s2.用户消息,
      工具: s2.工具,
      工具字: 本段工具字,
      对话字: Math.max(0, 字 - 本段工具字),
      内容: 名字.slice(0, 4).join('、'),
      字节,
      字,
      token: 实测 ? Math.round(实测 * 占比) : 估算字(字),
      占比: Math.round(占比 * 1000) / 10,
      子: [[s2.起, s2.到]],
    }
  })
  return {
    会话: 概要(文件),
    总字节,
    总token: 实测 || 估算字(总字),
    总工具字: 工具字,
    占用: 实测,
    窗口: 占用.窗口,
    占用率: 实测 ? Math.round((实测 / (占用.窗口 || 窗口token)) * 100) : 0,
    段: 合并段(清单),
    原始段数: 清单.length,
    时间线: 时间线(体, 实测),
  }
}

// 清完还剩多少 token（按正文字数估，中文约 1.6 字/token）
const 折叠上限 = 780000 // 窗口 1048576、ACP 预留后 792576，留一点余量
function 估体tokens(体) {
  let 字 = 0
  for (const e of 体) {
    if (e.type !== 'user/message' && e.type !== 'assistant/message' && e.type !== 'tool/result') continue
    const 瓶 = e.data && (e.data.message || e.data)
    const c = 瓶 && 瓶.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string') 字 += b.text.length
      if (typeof b.thinking === 'string') 字 += b.thinking.length
    }
  }
  return Math.round(字 / 1.6)
}
// 有压缩账的会话：清完如果还剩一大坨，先别重置账（重置就等于让它全量重发）
function 过闸(id, 全体) {
  if (!有折叠账(id)) return
  const 剩 = 估体tokens(全体)
  if (剩 <= 折叠上限) return
  throw new Error(
    `还没清够：清完还剩约 ${Math.round(剩 / 1000)}K token，超过折叠上限 ${Math.round(折叠上限 / 1000)}K。` +
      `这条会话有 billion-context 的压缩账，重置账之后它会把原文全量发出去，一定超窗。` +
      `请再多清一些（降保留轮数、或改用整轮删除），让剩余落到 ${Math.round(折叠上限 / 1000)}K 以下再来。`,
  )
}

// 有压缩账的会话，真实出网体积看账本（stats.contextTokens / lastInputTokens）；
// 不能拿文件大小或文件里 assistant 的 usage 当占用，否则会把好好的会话显示成爆满。
import { createRequire } from 'node:module'
const 需 = createRequire(import.meta.url)
let 账库 = undefined
function 打开账库() {
  if (账库 !== undefined) return 账库
  try {
    const 模 = 需('node:sqlite')
    账库 = new 模.DatabaseSync(ACP库, { readOnly: true })
  } catch {
    账库 = null
  }
  return 账库
}

function 账在用的tokens(id) {
  const 库 = 打开账库()
  if (!库) return 0
  try {
    const 取 = 库.prepare('select stats_json from sessions where session_id = ?')
    const 行 = 取.all(id)
    const 全 = 行.length ? 行 : 取.all('session-' + id)
    if (!全.length) return 0
    const 统 = JSON.parse(全[0].stats_json || '{}')
    const 值 = Number(统.contextTokens) || Number(统.lastInputTokens) || 0
    return 值 > 0 ? Math.round(值) : 0
  } catch {
    return 0
  }
}

function 重建(体, 删键起止, 模式 = 'all') {
  const 在窗口内 = (e) => 删键起止.some(([a, b]) => e.time >= a && e.time <= b)
  const 首条用户 = new Map()
  const 保留 = []
  for (const e of 体) {
    // 压缩账本引用的都是旧 seq，清完必然对不上，整类丢掉
    if (e.type.startsWith('compaction/')) continue
    let 源 = e
    // session/title 是元数据不是内容：不管落在哪个窗口里都得留着，否则会话名字会消失
    if (在窗口内(e) && e.type !== 'session/title') {
      if (模式 === 'tools') {
        // 只清工具：结果留壳（宿主校验 tool call 必须有着落），内容换占位
        if (e.type.startsWith('job/')) continue
        if (e.type === 'tool/result') {
          const 改 = structuredClone(e)
          delete 改.data?.meta
          if (改.data?.message) {
            改.data.message = { ...改.data.message, content: [{ type: 'text', text: '（工具结果已清除）' }] }
          }
          源 = 改
        }
        // tool/call 的 arguments 不能动：宿主会拿它跟 assistant 里声明的工具调用逐字比对
      } else if (模式 === 'drop') {
        // 整轮删：连 turn/start、step/*、turn/end 一起丢，轮数才会真的变小
        continue
      } else if (!骨架.has(e.type)) continue
    }
    const 副本 = 源 === e ? structuredClone(e) : 源
    // 全局清坐标：窗口外的老 replace / sourceEventSeqs 也一样会指向被删的 seq
    delete 副本.sourceEventSeqs
    delete 副本.sourceEventSeq
    if (副本.data && typeof 副本.data === 'object') delete 副本.data.sourceEventSeq
    if (副本.surfaceOp && typeof 副本.surfaceOp === 'object') 副本.surfaceOp = 'append'
    if (Array.isArray(副本.data?.messageSeqs)) 副本.data.messageSeqs = []
    if (副本.type === 'session/title') {
      // 宿主规则：只有「用户起的标题」才允许 messageSeqs 为空；llm/fallback 标题必须引用更早的人类消息，
      // 而那些消息可能已经被清掉。标题是给人看的，这里统一改写成「用户标题」并清空引用，保住名字。
      if (!副本.data || typeof 副本.data !== 'object') continue
      if (!副本.data.title) continue
      副本.data = { ...副本.data, source: { ...(副本.data.source || {}), kind: 'user' }, messageSeqs: [] }
    }
    if (表面.has(副本.type)) 副本.surfaceOp = 'append'
    if (副本.type === 'developer/message') continue
    // 收件箱拼接记账：记的是「往下一轮插了哪条 / 撤销了几条」，重编号后宿主要撤销一条不存在的插入，
    // 报 `invalid persisted inbox splice at session seq N`。正文本来就在 user/message 里，整类丢掉。
    if (副本.type === 'agent/inbox/spliced') continue
    // 图片卸载记账里写的是旧的表面 seq，重编号后必然指歪（`image/offload: target seq N is not a current surface node`）
    if (副本.type === 'image/offload') continue
    // 标题生成请求记录会和被清空的 messageSeqs 对不上
    if (副本.type === 'session/title-llm-request') continue
    if (副本.type.startsWith('session-log-')) continue
    保留.push(副本)
  }
  // 孤儿 tool/result：配对表里没有对应 tool/call 的直接丢
  const 有调用 = new Set(保留.filter((e) => e.type === 'tool/call').map((e) => e.data?.callId))
  const 过滤 = 保留.filter(
    (e) => e.type !== 'tool/result' || 有调用.has(e.data?.toolCallId ?? e.data?.message?.toolCallId),
  )
  // 宿主规则：表面事件的第一条必须是 system/message（受保护头），而且它得在开着的 turn/step 里。
  // 清完之后往往是 user/message 打头，宿主再追加自己的 system/message 就会报
  // `system/message requires a protected first surface head`，所以这里补一条（用原来第一条 system/message）。
  const 头系 = 体.find((e) => e.type === 'system/message')
  let 序 = 过滤.filter((e) => e.type !== 'system/message')
  if (头系) {
    const 头 = structuredClone(头系)
    delete 头.sourceEventSeqs
    delete 头.sourceEventSeq
    if (头.data && typeof 头.data === 'object') {
      delete 头.data.sourceEventSeq
      if (Array.isArray(头.data.messageSeqs)) 头.data.messageSeqs = []
    }
    头.surfaceOp = 'append'
    const 首轮 = 序.find((e) => e.type === 'turn/start')
    const 首步 = 序.find((e) => e.type === 'step/start')
    if (首轮) 头.data = { ...(头.data || {}), turn: Number(首轮.data?.turn) || 1 }
    if (首步) 头.data = { ...(头.data || {}), step: Number(首步.data?.step) || 1 }
    const 位 = 首步 ? 序.indexOf(首步) + 1 : 首轮 ? 序.indexOf(首轮) + 1 : 0
    序 = [...序.slice(0, 位), 头, ...序.slice(位)]
  }
  // 快照提前，再统一重编 seq
  const 快照类 = new Set([
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'model/selection',
    'session/title',
  ])
  const 最新 = new Map()
  for (const e of 序) if (快照类.has(e.type)) 最新.set(e.type, e)
  const 前置 = [...最新.values()]
  const 其余 = 序.filter((e) => !快照类.has(e.type))
  void 首条用户
  return { 前置, 其余 }
}

// ── 重复系统注入：每轮都会被重贴一遍的东西（记忆快照、运行上下文、system-reminder…），只留最新一份 ──
const 注入头表 = [
  { 类: '记忆快照', 头: /^MNEMON RUNTIME MEMORY SNAPSHOT/ },
  { 类: '运行上下文', 头: /^Current runtime context\./ },
  { 类: '时间采样', 头: /^Time sampled while preparing/ },
  { 类: 'mnemon 提示', 头: /^\[MNEMON\]/ },
  { 类: '系统提醒', 头: /^\[系统提醒\]/ },
  { 类: '技能清单', 头: /^<available_skills>/ },
  { 类: '工作区说明', 头: /^Instructions from:/ },
  { 类: 'system-reminder', 头: /^<system-reminder>/ },
]

function 消息包(e) {
  if (e.type !== 'user/message' && e.type !== 'system/message') return null
  const 消息 = e.data?.message ?? e.data
  const 块 = Array.isArray(消息?.content) ? 消息.content : null
  return 块 ? { 块 } : null
}

// 一段文本里哪些区段属于系统注入
function 注入区(text) {
  const 区 = []
  const re = /<system-reminder>[\s\S]*?<\/system-reminder>/g
  let m
  while ((m = re.exec(text))) 区.push({ 起: m.index, 止: m.index + m[0].length, 类: 'system-reminder' })
  if (区.length === 0) {
    for (const t of 注入头表) {
      if (t.头.test(text)) return [{ 起: 0, 止: text.length, 类: t.类 }]
    }
  }
  return 区
}

function 扫注入(体) {
  const 全 = []
  for (let i = 0; i < 体.length; i++) {
    const 包 = 消息包(体[i])
    if (!包) continue
    包.块.forEach((b, bi) => {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return
      for (const 区 of 注入区(b.text)) 全.push({ 事件: i, 块: bi, 起: 区.起, 止: 区.止, 类: 区.类, 字: 区.止 - 区.起 })
    })
  }
  return 全
}

function 统计注入(体) {
  const 全 = 扫注入(体)
  const 组 = new Map()
  for (const x of 全) {
    if (!组.has(x.类)) 组.set(x.类, [])
    组.get(x.类).push(x)
  }
  const 清单 = []
  let 可省 = 0
  for (const [类, 列] of 组) {
    列.sort((a, b) => a.事件 - b.事件 || a.块 - b.块 || a.起 - b.起)
    const 旧 = 列.slice(0, Math.max(0, 列.length - 保留份数))
    const 省 = 旧.reduce((a, x) => a + x.字, 0)
    可省 += 省
    清单.push({ 类, 处数: 列.length, 重复: 旧.length, 字: 列.reduce((a, x) => a + x.字, 0), 可省字: 省 })
  }
  清单.sort((a, b) => b.可省字 - a.可省字)
  return { 总处: 全.length, 保留份数, 可省字: 可省, 清单 }
}

// 把「同类注入」里除最后 N 条以外的全换成一行占位
function 折叠注入(体) {
  const 全 = 扫注入(体)
  const 组 = new Map()
  for (const x of 全) {
    if (!组.has(x.类)) 组.set(x.类, [])
    组.get(x.类).push(x)
  }
  const 目标 = []
  for (const 列 of 组.values()) {
    列.sort((a, b) => a.事件 - b.事件 || a.块 - b.块 || a.起 - b.起)
    目标.push(...列.slice(0, Math.max(0, 列.length - 保留份数)))
  }
  if (目标.length === 0) return { 体, 折叠: 0, 省字: 0 }
  const 按事件 = new Map()
  for (const x of 目标) {
    if (!按事件.has(x.事件)) 按事件.set(x.事件, [])
    按事件.get(x.事件).push(x)
  }
  let 省字 = 0
  for (const [ei, 列] of 按事件) {
    const e = structuredClone(体[ei])
    const 包 = 消息包(e)
    for (const x of 列.sort((a, b) => b.块 - a.块 || b.起 - a.起)) {
      const b = 包.块[x.块]
      if (!b || typeof b.text !== 'string') continue
      const 原 = b.text
      const 替换 = `（旧的${x.类}已省略，最新一份保留在后文）`
      const 新 = x.止 - x.起 >= 原.length - 1 ? 替换 : 原.slice(0, x.起) + 替换 + 原.slice(x.止)
      if (新.length >= 原.length) continue
      省字 += 原.length - 新.length
      b.text = 新
    }
    体[ei] = e
  }
  return { 体, 折叠: 目标.length, 省字 }
}

function 写会话(头, 事件, 出口) {
  // 宿主要求：第一帧只有 header 一行，之后每帧若干事件
  const 缓冲 = [
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(头) + '\n', 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }),
  ]
  for (let i = 0; i < 事件.length; i += 每帧行数) {
    const 块 = 事件.slice(i, i + 每帧行数).map((e) => JSON.stringify(e)).join('\n') + '\n'
    缓冲.push(
      zlib.zstdCompressSync(Buffer.from(块, 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    )
  }
  fs.writeFileSync(出口, Buffer.concat(缓冲))
}

// 用宿主自己的持久化校验器（离线跑，不用重启）验一份文件
function 宿主校验(文件, 事件数) {
  return new Promise((好) => {
    if (!fs.existsSync(校验器)) return 好({ ok: true, message: '（没装离线校验器，跳过）' })
    let 结束 = false
    const 收 = (r) => {
      if (结束) return
      结束 = true
      try {
        工.terminate()
      } catch {}
      好(r)
    }
    let 工
    try {
      工 = new Worker(校验器, {
        workerData: { path: 文件, compression: 'zstd', expectedEventCount: 事件数 },
      })
    } catch (e) {
      return 好({ ok: true, message: '（校验器起不来：' + String(e?.message || e) + '，跳过）' })
    }
    工.on('message', (m) => 收(m && typeof m === 'object' ? m : { ok: false, message: String(m) }))
    工.on('error', (e) => 收({ ok: true, message: '（校验器报错：' + String(e?.message || e) + '，跳过）' }))
    工.on('exit', () => 收({ ok: true, message: '（校验器没给结论，跳过）' }))
    setTimeout(() => 收({ ok: false, message: '校验器超时' }), 20000)
  })
}

async function 校验(文件) {
  const { 头, 体 } = 读会话(文件)
  const 问题 = []
  const 事件 = 体.map((e) => e.type)
  // 轮/步配对
  let 开轮 = 0
  for (const e of 体) {
    if (e.type === 'turn/start') 开轮 += 1
    if (e.type === 'turn/end') 开轮 -= 1
    if (开轮 < 0) 问题.push('turn/end 多于 turn/start')
  }
  for (let i = 0; i < 体.length; i += 1) if (体[i].seq !== i) { 问题.push(`seq 不连续于 ${i}`); break }
  const 有调用 = new Set(体.filter((e) => e.type === 'tool/call').map((e) => e.data?.callId))
  for (const e of 体) {
    if (e.type === 'tool/result') {
      const id2 = e.data?.toolCallId ?? e.data?.message?.toolCallId
      if (!有调用.has(id2)) 问题.push(`孤儿 tool/result ${e.seq}`)
    }
    if (Array.isArray(e.sourceEventSeqs)) {
      for (const s of e.sourceEventSeqs) if (!(s < e.seq)) 问题.push(`${e.type} 的 sourceEventSeqs 指向不更早的 ${s}`)
    }
    if (e.surfaceOp && typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') 问题.push(`残留 replace ${e.seq}`)
  }
  return { 头, 问题: [...new Set(问题)].slice(0, 8), 事件: 体.length }
}

const 备份保留 = 10
// 本次宿主进程的启动时刻（插件热重载时不变），用来判断「等重启」标记是不是这一轮宿主留下的
const 本次进程起 = Math.round(Date.now() - process.uptime() * 1000)
const 待重启文件 = path.join(备份根, 'pending-restart.json')

function 读待重启() {
  try {
    const 全 = JSON.parse(fs.readFileSync(待重启文件, 'utf8')) || {}
    const 留 = {}
    for (const [id, 值] of Object.entries(全)) {
      if (值 && 值.进程起 === 本次进程起) 留[id] = 值
    }
    return 留
  } catch {
    return {}
  }
}

// ---- billion-context（压缩插件）的折叠账 ----
// 它按「消息引用」记账：删事件 / 重排序号都会让账悬空（日志里叫 DIGEST DRIFT，然后整本 dropped），
// 之后它只能按原文重发，于是本来靠折叠撑着的大会话就会 413。
// 所以凡是改过文件的会话，都要顺手把它的账本清掉，让它按新文件从零折叠；清之前先备份账本文件。
const ACP目录 =
  process.env.BILLION_CONTEXT_DIR || path.join(家, '.local', 'share', 'billion-context', 'sessions')
const ACP库 = path.join(ACP目录, 'index.db')
// 账本里的 session_id 有两种写法：带 `session-` 前缀的、和不带的（自定义 id），两个都要试。
function 账本键(id) {
  const 裸 = String(id).replace(/^session-/, '')
  return [...new Set([裸, `session-${裸}`])]
}

// 一次请求可能落在「主车道」或 `<主id>|sub:<hex>` 子车道，账都记在对应车道上。
// 这里把两种主键和所有子车道键一起列出来。
function 全部账键(db, id) {
  const 出 = []
  for (const 键 of 账本键(id)) {
    出.push(键)
    try {
      const 子 = db.prepare('select distinct session_id from blocks where session_id like ?').all(键 + '|sub:%')
      for (const r of 子) 出.push(r.session_id)
    } catch {}
  }
  return [...new Set(出)]
}
// 「有没有 billion-context 折叠账」= blocks 表里还有 active 块。
// 注意：没有这块账不代表会话会爆，DSH 自己的上下文压缩还在；插件只是没法用它做「折叠记忆」。
function 有折叠账(id) {
  try {
    if (!fs.existsSync(ACP库)) return false
    const { DatabaseSync } = require_node_sqlite()
    const db = new DatabaseSync(ACP库, { readOnly: true })
    let 有 = false
    for (const 键 of 全部账键(db, id)) {
      const r = db.prepare('select 1 from blocks where session_id = ? and active = 1 limit 1').get(键)
      if (r) { 有 = true; break }
    }
    db.close?.()
    return 有
  } catch {
    return false
  }
}
let sqlite模块
function require_node_sqlite() {
  if (!sqlite模块) sqlite模块 = process.getBuiltinModule('node:sqlite')
  return sqlite模块
}
function 重置折叠账(id, 备注 = 'clean') {
  const 结果 = { 有账: false, 删块: 0, 备份: [], 键: [] }
  try {
    const { DatabaseSync } = require_node_sqlite()
    const db = new DatabaseSync(ACP库)
    for (const 键 of 账本键(id)) {
      const 块 = db.prepare('select count(*) c from blocks where session_id = ?').get(键).c
      if (!块) continue
      结果.有账 = true
      结果.删块 += 块
      结果.键.push(键)
      db.prepare('delete from blocks where session_id = ?').run(键)
      db.prepare('delete from messages where session_id = ?').run(键)
      db.prepare('delete from refs where session_id = ?').run(键)
      db.prepare('delete from dead_refs where session_id = ?').run(键)
      db.prepare('delete from conversations where session_id = ?').run(键)
    }
    db.close?.()
  } catch (e) {
    结果.错 = String(e && e.message ? e.message : e)
  }
  // 账本快照文件也挪走（它才是 drift 的直接来源）
  const 候选 = new Set(账本键(id))
  try {
    for (const n of fs.readdirSync(ACP目录)) {
      if (!n.endsWith('.json')) continue
      const p = path.join(ACP目录, n)
      let 命中 = false
      try {
        const 头 = JSON.parse(fs.readFileSync(p, 'utf8'))
        const said = String(头.id || 头.payload?.id || '')
        for (const 键 of 候选) if (said === 键 || said.startsWith(`${键}|`)) 命中 = true
      } catch {}
      if (!命中) continue
      const 新 = `${p}.reset-${备注}-${Date.now()}`
      fs.renameSync(p, 新)
      结果.备份.push(path.basename(新))
    }
  } catch {}
  return 结果
}

function 标待重启(id, 动作) {
  const 全 = 读待重启()
  const 键 = String(id).replace(/^session-/, '')
  全[键] = { 动作, 时间: Date.now(), 进程起: 本次进程起 }
  fs.mkdirSync(备份根, { recursive: true })
  fs.writeFileSync(待重启文件, JSON.stringify(全, null, 2))
}

function 修剪备份(文件) {
  const 键 = `${path.basename(path.dirname(文件))}.${path.basename(文件)}.`
  const 同组 = fs
    .readdirSync(备份根)
    .filter((n) => n.startsWith(键) || n.startsWith(path.basename(文件) + '.'))
    .map((n) => ({ n, t: fs.statSync(path.join(备份根, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const { n } of 同组.slice(备份保留)) {
    try {
      fs.rmSync(path.join(备份根, n), { force: true })
    } catch {}
  }
}

function 备份(文件, 备注) {
  fs.mkdirSync(备份根, { recursive: true })
  // 名字里带上会话目录名（session-<id>），这样面板能按会话分组，还原时也能认出是哪个会话
  const 会话名 = path.basename(path.dirname(文件)) || 'session'
  const 名 = `${会话名}.${path.basename(文件)}.${Date.now()}${备注 ? '.' + 备注 : ''}`
  fs.copyFileSync(文件, path.join(备份根, 名))
  try {
    修剪备份(文件)
  } catch {}
  return 名
}

function 列备份() {
  if (!fs.existsSync(备份根)) return []
  return fs
    .readdirSync(备份根)
    .filter((n) => n.includes('session.v4.jsonl.zstd'))
    .map((n) => {
      const st = fs.statSync(path.join(备份根, n))
      // 备份名 = <会话目录名>.<文件名>.<时间戳>.<备注>；会话目录名可能没有 session- 前缀
      const 目录名 = n.split('.')[0]
      const 会话id = n.startsWith('session.v4.jsonl.zstd')
        ? ''
        : 目录名.startsWith('session-')
          ? 目录名.slice('session-'.length)
          : 目录名
      const 尾 = n.split('.').pop() || ''
      return { 名: n, 字节: st.size, 时间: st.mtimeMs, 会话id, 备注: 尾.startsWith('before-') ? 尾 : '' }
    })
    .sort((a, b) => b.时间 - a.时间)
}

// 宿主正开着这个会话时去改文件，会和内存里的状态抢同一个 seq（2026-11-16 那次就是这样）。
// 注意：liveEntryFor 收的是 session 对象而不是 id，传 id 会抛错，所以这里用 get(id) / list()。
async function 正在用(id) {
  if (!会话API) return ''
  const 真id = String(id).startsWith('session-') ? String(id) : `session-${String(id)}`
  try {
    if (typeof 会话API.get === 'function') {
      const 一条 = await 会话API.get(真id)
      if (一条) return 真id
    }
    if (typeof 会话API.list === 'function') {
      const 表 = await 会话API.list()
      const 全 = Array.isArray(表) ? 表 : []
      if (全.some((x) => String(x?.id ?? x?.header?.id ?? '') === 真id)) return 真id
    }
  } catch (e) {
    记(`挡活会话查不到（${String(e?.message || e)}），放行`)
  }
  return ''
}

async function 挡活会话(id, 强制 = false) {
  if (!会话API) {
    throw new Error('拿不到宿主的会话接口，没法确认这个会话没在跑。为免抢号，这次不动它——重启 DSH 后再试。')
  }
  // 「等重启」标记不再拦插件的后续清理：清文件是幂等的，多步可以连着做；
  // 它只用来拦住「重启前又去那个会话里说话」（/ask 会单独查这个标记）。
  const 活 = await 正在用(id)
  if (活) {
    if (强制) {
      记(`强制清理活会话 ${活}（用户确认后立刻重启）`)
      return
    }
    const 错 = new Error(`「${活}」正在宿主里跑着（刚打开过）。先关掉它或重启 DSH 再清，否则会和内存里的状态抢同一个 seq。`)
    错.活会话 = 活
    throw 错
  }
}

async function 执行去重(id, 强制 = false) {
  await 挡活会话(id, 强制)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 原字节 = fs.statSync(s.文件).size
  const { 体: 新体, 折叠, 省字 } = 折叠注入(体)
  if (折叠 === 0) throw new Error('没有重复的系统注入可折')
  // 折完再走一遍统一规整（清坐标、丢压缩账本、重编 seq）
  const 规整 = 重建(新体, [])
  const 全部 = [...规整.前置, ...规整.其余].map((e, i) => ({ ...e, seq: i }))
  const 临时 = s.文件 + '.deduping'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  // 本地检查偏严（老文件本身就有乱序 seq），只当提示；真正拦人的是宿主校验
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error(`宿主校验没过：${真验.message || '未知'}`)
  }
  const 备份名 = 备份(s.文件, 'before-dedupe')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (fs.existsSync(投影)) fs.rmSync(投影, { force: true })
  标待重启(s.id, '折叠注入')
  try { 重置折叠账(s.id, 'dedupe') } catch {}
  return { 备份: 备份名, 折叠, 省字, 原字节, 新字节: fs.statSync(s.文件).size, 事件: 查.事件 }
}

// 往目标会话尾部追加一条 user 消息：让那个会话自己产出上下文构成，插件不去猜内容
const 提问模板 = [
  '帮我按「工作内容」把我这一整段上下文切一下，输出一张表。要求：',
  '1. 每行一个工作内容，写清：工作内容 / 大约占用（K token） / 内容（那一段具体在干什么，举两三个代表性动作或产物）；',
  '2. 按占用从大到小排，最后单列一行「摘要块本身」，那是之前压缩出来的记忆；',
  '3. 表下面写一条建议：哪些行可以扔、哪些结论要留，说清大概能压到多少 K；',
  '4. 只按你实际看到的上下文估，别编。',
].join('\n')

// 走宿主自己的入口把话发进会话：sessionController.resolveAgent(id) → agent.followup(message)
// （宿主 API 的 session.prompt 内部也是这么做的，见 dsh-api-session-controller/lib/index.js）
function 造用户消息(内容, rpcId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(内容) }],
    source: { kind: 'user', rpcId, clientTimeZone: 'Etc/GMT-8' },
  }
}

// 读活会话里的事件（优先用宿主的会话对象，退回去读文件）
function 活事件(agent, 文件) {
  try {
    const s = agent?.session
    for (const 名 of ['eventsSnapshot', 'ownEvents']) {
      if (typeof s?.[名] === 'function') {
        const r = s[名]()
        if (Array.isArray(r)) return r
      }
    }
  } catch {}
  try {
    return 读会话(文件).体
  } catch {
    return []
  }
}

// ── 往会话里投话：优先走宿主的 HTTP RPC（带着浏览器请求里的 cookie，宿主才认），
//    拿不到 cookie 才退回进程内的 sessionController ──
function 深找(值, 判, 出 = [], 深 = 0) {
  if (!值 || typeof 值 !== 'object' || 深 > 8) return 出
  if (Array.isArray(值)) {
    for (const v of 值) 深找(v, 判, 出, 深 + 1)
    return 出
  }
  if (判(值)) 出.push(值)
  for (const v of Object.values(值)) 深找(v, 判, 出, 深 + 1)
  return 出
}

// 面板 / 会话共用的那张表：插件先写好空表，会话只补「工作内容」「建议」两列，用户在面板上勾
function 表文件(文件) {
  const id = path.basename(path.dirname(文件))
  return path.join(备份根, '构成表', `${id}.md`)
}

function 写表模板(会话名, 目标) {
  fs.mkdirSync(path.dirname(目标), { recursive: true })
  const 文 = [
    `# 上下文构成 · ${会话名}`,
    '',
    '<!-- 行由会话自己切（按工作内容归并），插件不切段、只解析。「时间范围」写成 `11-17 19:00 → 11-17 21:30`，没跨天可以只写后半的 `21:30`。 -->',
    '',
    '| 工作内容 | 时间范围 | 大约占用 | 建议 |',
    '| --- | --- | --- | --- |',
    '',
  ].join('\n')
  fs.writeFileSync(目标, 文, 'utf8')
  return 目标
}

// 时间线只是参考：按自然小时聚合，不替会话切段
function 时间线(体, 实测token, 粒度 = 'auto') {
  const 桶 = new Map()
  for (const e of 体) {
    const t = typeof e.time === 'number' ? e.time : 0
    if (!t) continue
    const d = new Date(t)
    const 键 = 粒度 === 'day'
      ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}`
    const b = 桶.get(键) || { 起: t, 止: t, 字: 0 }
    b.起 = Math.min(b.起, t)
    b.止 = Math.max(b.止, t)
    b.字 += 正文字数(e)
    桶.set(键, b)
  }
  const 全 = [...桶.values()].sort((a, b) => a.起 - b.起)
  // 小时级超过 60 桶就退到按天，免得参考表本身把上下文吃掉
  if (粒度 === 'auto' && 全.length > 60) return 时间线(体, 实测token, 'day')
  const 总字 = 全.reduce((a, x) => a + x.字, 0) || 1
  const 总token = 实测token || 估算字(总字)
  return 全.map((b) => ({ 起: 字时(b.起), 止: 字时(b.止), K: Math.round((总token * (b.字 / 总字)) / 1000) }))
}

// 会话写回来的「时间范围」→ [起ms, 止ms]；只写时刻不给日期时沿用前半段的日期
function 解析区间(文, 年) {
  const 片 = String(文 || '').split(/→|->|~|—|–|～|到/).map((x) => x.trim()).filter(Boolean)
  if (!片.length) return null
  const 取 = (s, 默) => {
    const 全 = s.match(/(?:(\d{1,2})-(\d{1,2})\s+)?(\d{1,2}):(\d{2})/)
    if (!全) return null
    const 月 = 全[1] ? Number(全[1]) : 默.月
    const 日 = 全[2] ? Number(全[2]) : 默.日
    return { ms: new Date(年, 月 - 1, 日, Number(全[3]), Number(全[4])).getTime(), 月, 日 }
  }
  const 首 = 取(片[0], { 月: 1, 日: 1 })
  if (!首) return null
  const 尾 = 片[1] ? 取(片[1], 首) : 首
  if (!尾) return null
  const [a, b] = [首.ms, 尾.ms].sort((x, y) => x - y)
  return [a, b]
}

// 让会话把行和建议填进插件事先放好的那张表里，面板读回来直接给用户勾
function 构提问(线, 会话名, 表路径, 总token) {
  if (!线.length) throw new Error('这个会话的时间线是空的（日志可能正在被重写），过几秒再点一次')
  const 行 = 线.map((x) => `${x.起} → ${x.止} | ~${x.K}K`)
  return [
    `插件不替你切段，只把「${会话名}」的时间线给你：按时间聚合（小时级，太碎就按天），token 是插件按正文占比估的。总计约 ~${Math.round((总token || 0) / 1000)}K。`,
    '',
    '时间范围 | 大约占用',
    ...行,
    '',
    '1. 行怎么切你自己定：按工作内容归并，同一件事的几个小时合成一行，不必跟上面的小时对齐。',
    '2. 列不许改，就这四列：工作内容 / 时间范围 / 大约占用 / 建议。',
    '   「工作内容」5-20 字；「时间范围」写成 `11-17 19:00 → 11-17 21:30`（没跨天可以只写 `21:30`），必须落在上面时间线覆盖的范围内；',
    '   「大约占用」写这行合计的 K；「建议」只写「留」或「删」；整张表按占用从大到小排。',
    '3. 表下面写两三句总结：哪些可以直接扔、哪些结论必须留、按这样清大概能压到多少 K。',
    `4. 把这张表填入「插件文件」中：${表路径}`,
    '   （文件里只有表头，你往下写行就行；列标题别改。）',
  ].join('\n')
}

// 读会话填好的那张表：| 工作内容 | 覆盖编号 | 大约占用 | 建议 |
// 「覆盖编号」可以写 0-3、0,2,5 或 0、2；插件按编号把时间范围并起来，删除时按这些区间切
function 展开覆盖(格, 段表) {
  const 号 = new Set(段表.map((s) => String(s.键)))
  const 出 = []
  const 原文 = String(格 || '')
  for (const 片 of 原文.split(/[,，、;；\s]+/)) {
    const 文 = 片.trim()
    if (!文) continue
    const 区 = 文.match(/^(\d+)\s*[-~—到]\s*(\d+)$/)
    if (区) {
      const [a, b] = [Number(区[1]), Number(区[2])].sort((x, y) => x - y)
      for (let i = a; i <= b; i += 1) if (号.has(String(i))) 出.push(String(i))
      continue
    }
    const 单 = 文.match(/\d+/g)
    if (单) for (const d of 单) if (号.has(d)) 出.push(d)
  }
  return [...new Set(出)]
}

// 读会话填好的那张表：| 工作内容 | 时间范围 | 大约占用 | 建议 |
// 「时间范围」由会话自己写（`11-17 19:00 → 11-17 21:30`），插件只把它解析成 ms 区间；
// 老格式（第二列是「覆盖编号」）仍然认，兜底用段表还原。
function 解析表文件(路径, 段表, 年) {
  if (!fs.existsSync(路径)) return null
  const 文 = fs.readFileSync(路径, 'utf8')
  const 表 = []
  for (const 行 of 文.split(/\r?\n/)) {
    const 行文 = 行.trim()
    if (!行文.startsWith('|')) continue
    const 格 = 行文.split('|').slice(1, -1).map((x) => x.trim())
    if (格.length < 3) continue
    if (/^-+$/.test(格[0].replace(/[:\s]/g, ''))) continue
    const 名 = (格[0] || '').trim()
    if (!名 || /^工作内容$/.test(名)) continue
    const 建议 = (格[格.length - 1] || '').trim()
    const 区间 = 解析区间(格[1], 年)
    let 覆盖 = []
    let 取 = []
    let 子 = []
    let token = 0
    if (区间 && 区间[1] > 区间[0]) {
      子 = 区间
      // 体积按段表和区间的重叠比例估
      取 = 段表.filter((s) => s.止ms > 区间[0] && s.起ms < 区间[1])
      token = 取.reduce((a, s) => a + (s.token || 0) * Math.min(1, (Math.min(s.止ms, 区间[1]) - Math.max(s.起ms, 区间[0])) / Math.max(1, s.止ms - s.起ms)), 0)
      token = Math.round(token)
      子 = [区间]
    } else {
      覆盖 = 展开覆盖(格[1], 段表)
      if (!覆盖.length) continue
      取 = 覆盖.map((k) => 段表.find((s) => String(s.键) === k)).filter(Boolean)
      子 = 取.flatMap((x) => (Array.isArray(x.子) && x.子.length ? x.子 : [[x.起ms, x.止ms]])).filter(([a, b]) => b > a)
      token = 取.reduce((a, x) => a + (x.token || 0), 0)
    }
    if (!子.length) continue
    表.push({
      键: String(表.length),
      名: 名.slice(0, 40),
      覆盖,
      起: 字时(子[0][0]),
      止: 字时(子[子.length - 1][1]),
      起ms: 子[0][0],
      止ms: 子[子.length - 1][1],
      子,
      内容: [...new Set(取.map((x) => x.内容).filter(Boolean))].slice(0, 4).join('、'),
      token,
      工具字: 取.reduce((a, x) => a + (x.工具字 || 0), 0),
      对话字: 取.reduce((a, x) => a + (x.对话字 || 0), 0),
      留: 建议.includes('删') ? '删' : '留',
      可省K: Math.round(token / 1000),
    })
  }
  if (!表.length) return null
  // 表下面那两三句总结
  const 总结 = 文
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim()
      return t && !t.startsWith('|') && !t.startsWith('#') && !t.startsWith('<!--')
    })
    .join(' ')
    .slice(0, 600)
  // 面板里按占用从大到小排（用 token 本身，别用四舍五入后的 K，否则小行会互相打平）
  return { 表: 表.sort((a, b) => (b.token || 0) - (a.token || 0)), 建议: 总结 }
}

// 从会话的回复里抠出那个 json 块（可能包在 ``` 里，也可能夹在正文里）

async function 宿主投问(文件, 题, req) {
  const 真id = path.basename(path.dirname(文件))
  // 服务可能在宿主启动晚些才注册，所以每次都重新找一遍（找不到才退回 HTTP 那条路）
  for (const 名 of ['sessionController', 'sessionControllerService', 'sessionControl']) {
    if (会话控 && typeof 会话控.resolveAgent === 'function') break
    try {
      const 候 = 宿主ctx?.get?.(名)
      if (候 && typeof 候.resolveAgent === 'function') 会话控 = 候
    } catch {}
  }
  const 头 = req?.headers || {}
  const host = String(头.host || '')
  const cookie = String(头.cookie || '')
  const rpcId = randomUUID()
  const 内容 = String(题 || 提问模板)
  if ((!会话控 || typeof 会话控.resolveAgent !== 'function') && host && cookie) {
    // 宿主网关的路由是 /api/<service>/<action>，会话控制器的投递方法就是 session/prompt
    const 底 = `http://${host}/api/`
    const 调 = async (path, payload) => {
      const r = await fetch(底 + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: path.replace('/', '.'), payload }),
      })
      const t = await r.text()
      if (!r.ok) throw new Error(`${path} ${r.status}：${t.slice(0, 200)}`)
      try {
        return JSON.parse(t)
      } catch {
        return { 原文: t }
      }
    }
    await 调('session/prompt', {
      sessionId: 真id,
      mode: 'queue',
      content: [{ type: 'text', text: 内容 }],
      clientTimeZone: 'Etc/GMT-8',
    })
    // 回话不去问网关要，直接盯会话文件：宿主每批写入后就能读到
    const 截止 = Date.now() + 240000
    let 见过 = false
    let 最长 = ''
    while (Date.now() < 截止) {
      await new Promise((r) => setTimeout(r, 500))
      let 体 = []
      try {
        体 = 读会话(文件).体
      } catch {
        continue
      }
      for (const e of 体) {
        if (e.type === 'user/message' && e?.data?.source?.rpcId === rpcId) 见过 = true
        if (!见过 || e.type !== 'assistant/message') continue
        const t = 文本(e.data?.message)
        if (t && t.length > 最长.length) 最长 = t
      }
      if (最长) return { 模式: '宿主', 文本: 最长, rpcId }
    }
    if (!见过) throw new Error('宿主没接住这条提问（会话可能正忙），等它空下来再试')
    return { 模式: '宿主', 文本: 最长, rpcId, 超时: true }
  }
  // 兜底：进程内取 sessionController（某些版本宿主才把它当服务暴露）
  if (!会话控 || typeof 会话控.resolveAgent !== 'function') return null
  const 解 = await 会话控.resolveAgent(真id)
  const agent = 解 && 解.agent ? 解.agent : 解
  if (!agent || typeof agent.followup !== 'function') {
    throw new Error('拿不到这个会话的 agent（先在界面上把它打开一次再试）')
  }
  agent.followup(造用户消息(内容, rpcId))
  const 截止 = Date.now() + 240000
  let 见过 = false
  let 最长 = ''
  while (Date.now() < 截止) {
    await new Promise((r) => setTimeout(r, 500))
    for (const e of 活事件(agent, 文件)) {
      if (e?.type === 'user/message' && e?.data?.source?.rpcId === rpcId) 见过 = true
      if (!见过 || e?.type !== 'assistant/message') continue
      const t = 文本(e.data?.message)
      if (t && t.length > 最长.length) 最长 = t
    }
    if (最长) return { 模式: '宿主', 文本: 最长, rpcId }
  }
  if (!见过) throw new Error('宿主没接住这条提问（会话可能正忙），等它空下来再试')
  return { 模式: '宿主', 文本: 最长, rpcId, 超时: true }
}


// ---- 「表」这一屏的状态：面板关掉再打开、甚至刷新页面后要能回到同一张表 ----
// 存插件这边（而不是只存浏览器），换浏览器/清缓存也不丢
const 表视图文件 = path.join(备份根, '表视图.json')

function 读表视图() {
  try {
    const s = fs.readFileSync(表视图文件, 'utf8')
    const v = JSON.parse(s)
    if (!v || typeof v !== 'object') return null
    // 上一次运行（重启 DSH 之前）留下的表，不再恢复
    if (Number(v.时) < 本次进程起) {
      fs.rmSync(表视图文件, { force: true })
      return null
    }
    return v
  } catch {
    return null
  }
}

// 浏览器那头丢了视图（切走 / 请求断开）时，从会话真正填过的表文件里重建
function 恢复表视图() {
  const 夹 = path.join(备份根, '构成表')
  let 名单 = []
  try {
    名单 = fs.readdirSync(夹)
      .filter((n) => n.endsWith('.md'))
      .map((n) => ({ n, t: fs.statSync(path.join(夹, n)).mtimeMs }))
      .filter((x) => x.t >= 本次进程起)
      .sort((a, b) => b.t - a.t)
  } catch {
    return null
  }
  let 会表 = []
  try { 会表 = 列会话() } catch { return null }
  for (const { n, t } of 名单) {
    const 名 = n.replace(/\.md$/, '')
    const 会 = 会表.find((s) =>
      path.basename(path.dirname(s.文件)) === 名 ||
      s.id === 名 || s.id === `session-${名}` || `session-${s.id}` === 名)
    if (!会) continue
    let 分析 = null
    try { 分析 = 分析文件(会.文件) } catch { continue }
    if (!分析 || !Array.isArray(分析.段) || !分析.段.length) continue
    let 解析 = null
    try { 解析 = 解析表文件(path.join(夹, n), 分析.段, new Date(分析.段[0].起ms || Date.now()).getFullYear()) } catch {}
    if (解析 && Array.isArray(解析.表) && 解析.表.length) {
      const 视图 = { sid: 会.id, 会话名: 会.标题 || 会.id, 表: 解析.表, 建议: 解析.建议 || '', 原文: '', 时: t }
      try { 写表视图(视图) } catch {}
      return 视图
    }
  }
  return null
}

function 写表视图(v) {
  try {
    fs.mkdirSync(备份根, { recursive: true })
    if (!v || v.退出 || !Array.isArray(v.表) && !v.原文) {
      fs.rmSync(表视图文件, { force: true })
      return { 清掉: true }
    }
    const 存 = { 表: Array.isArray(v.表) ? v.表 : [], 建议: String(v.建议 || ''), 原文: String(v.原文 || ''), 当前: String(v.当前 || ''), 会话名: String(v.会话名 || ''), 勾: v.勾 && typeof v.勾 === 'object' ? v.勾 : {}, 时: Number(v.时) || Date.now() }
    fs.writeFileSync(表视图文件, JSON.stringify(存))
    return { 存下: 存.表.length || (存.原文 ? '原文' : 0) }
  } catch (e) {
    return { 错: e instanceof Error ? e.message : String(e) }
  }
}

// 按「时间段」清：面板上那张表是合并过的段，带上的是 [起ms, 止ms]，不再依赖分段下标
async function 执行清除区间(id, 区间表, 模式 = 'all', 强制 = false) {
  await 挡活会话(id, 强制)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (Array.isArray(区间表) ? 区间表 : [])
    .map((r) => [Number(r?.起ms ?? r?.[0]), Number(r?.止ms ?? r?.[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
  if (!区间.length) throw new Error('没有选中任何段')
  const 原字节 = fs.statSync(s.文件).size
  const { 前置, 其余 } = 重建(体, 区间, 模式)
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  if (模式 === 'drop') 重编轮步(全部)
  const 临时 = s.文件 + '.cleaning'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error(`宿主校验没过：${真验.message || '未知'}`)
  }
  const 备份名 = 备份(s.文件, 'before-clean')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (fs.existsSync(投影)) fs.rmSync(投影, { force: true })
  标待重启(s.id, '清除')
  try { 重置折叠账(s.id, 'clean') } catch {}
  return {
    备份: 备份名,
    剩余事件: 查.事件,
    原字节,
    新字节: fs.statSync(s.文件).size,
    删除段: 区间.map(([a, b]) => `${字时(a)}→${字时(b)}`),
  }
}

// 按轮数清：保留最近 N 轮，把更早轮次的工具结果换成占位（工具调用本身不动）
// 整轮删掉之后，轮号会出现空洞（比如只剩 303..312），宿主按轮号走会把面板的轮数算错，
// 所以按剩下来的顺序重排成 1..N，步号跟着每轮从 1 重排。
function 重编轮步(全部) {
  const 轮序 = []
  for (const e of 全部) {
    if (e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn))) 轮序.push(Number(e.data.turn))
  }
  const 轮映 = new Map([...new Set(轮序)].map((t, i) => [t, i + 1]))
  const 步映 = new Map()
  const 步计 = new Map()
  for (const e of 全部) {
    const t = Number(e.data?.turn)
    const st = Number(e.data?.step)
    if (e.type === 'step/start' && Number.isFinite(t) && Number.isFinite(st)) {
      const n = (步计.get(t) || 0) + 1
      步计.set(t, n)
      步映.set(`${t}:${st}`, n)
    }
  }
  for (const e of 全部) {
    const d = e.data
    if (!d || typeof d !== 'object') continue
    const t = Number(d.turn)
    const st = Number(d.step)
    if (Number.isFinite(t) && 轮映.has(t)) d.turn = 轮映.get(t)
    if (Number.isFinite(t) && Number.isFinite(st)) {
      const m = 步映.get(`${t}:${st}`)
      if (m) d.step = m
    }
  }
  return 全部
}

// 从 billion-context 的账里取压缩记忆（active 块的正经摘要；原文不取）
async function 取压缩记忆(id) {
  const 库 = ACP库
  if (!fs.existsSync(库)) return []
  let 模
  try {
    模 = await import('node:sqlite')
  } catch {
    return []
  }
  const 句柄 = new 模.DatabaseSync(库, { readOnly: true })
  try {
    let 最好 = null
    let 最多次 = 0
    for (const 键 of 全部账键(句柄, id)) {
      const c = 句柄.prepare('select count(*) c from blocks where session_id = ? and active = 1').get(键)
      if (Number(c?.c || 0) > 最多次) { 最多次 = Number(c.c); 最好 = 键 }
    }
    for (const 键 of 最好 ? [最好] : []) {
      const 行 = 句柄
        .prepare('select ord, payload_json from blocks where session_id = ? and active = 1 order by ord')
        .all(键)
      const 出 = []
      for (const r of 行) {
        let p = null
        try {
          p = JSON.parse(r.payload_json)
        } catch {}
        const 文 = p && typeof p.summary === 'string' ? p.summary : p && typeof p.text === 'string' ? p.text : ''
        if (!文) continue
        const 题 = (p && typeof p.topic === 'string' && p.topic) || (p && typeof p.title === 'string' && p.title) || ''
        出.push({ 序: Number(r.ord), 题, 文 })
      }
      if (出.length) return 出
    }
    return []
  } finally {
    try {
      句柄.close()
    } catch {}
  }
}

// 折叠记忆替换对话：老轮次整段删掉，换成账里的压缩记忆，接上最近 N 轮原文
async function 执行记忆替换(id, 保留轮数 = 20, 记忆源 = '', 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 记忆 = await 取压缩记忆(记忆源 || id)
  if (!记忆.length) {
    throw new Error('这条会话没有可用的折叠记忆（没有压缩账，或账被重置过）。先用「工具结果」或「整轮删除」清一部分。')
  }
  const 保留 = Math.max(1, Math.floor(Number(保留轮数) || 20))
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  const 起点轮 = Math.max(1, 总轮 - 保留 + 1)
  const 界 = 轮头.find((e) => Number(e.data.turn) >= 起点轮)
  if (!界 || 界 === 轮头[0]) throw new Error('保留 ' + 保留 + ' 轮就是全部 ' + 总轮 + ' 轮，没有更早的可替换')

  const 源系统 = 体.find((e) => e.type === 'system/message')
  const 基时 = Number(体[0].time) || Date.now()
  const 记忆消息 = 记忆.map((m, i) => ({
    type: 'user/message',
    seq: 0,
    time: 基时 + i,
    data: {
      role: 'user',
      id: randomUUID(),
      content: [
        {
          type: 'text',
          text: '【压缩记忆 ' + (i + 1) + '/' + 记忆.length + '｜' + (m.题 || '第 ' + m.序 + ' 块') + '】\n' + m.文,
        },
      ],
      source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Etc/GMT-8' },
    },
    surfaceOp: 'append',
  }))
  const 起 = { type: 'turn/start', seq: 0, time: 基时, data: { turn: 1 } }
  const 步起 = { type: 'step/start', seq: 0, time: 基时, data: { turn: 1, step: 1 } }
  const 系统 = 源系统
    ? { ...JSON.parse(JSON.stringify(源系统)), seq: 0, data: { ...JSON.parse(JSON.stringify(源系统.data)), turn: 1, step: 1 } }
    : null
  if (系统) delete 系统.sourceEventSeqs
  const 步终 = { type: 'step/end', seq: 0, time: 基时 + 记忆.length + 1, data: { turn: 1, step: 1 } }
  const 轮终 = { type: 'turn/end', seq: 0, time: 基时 + 记忆.length + 2, data: { turn: 1, reason: { kind: 'completed' } } }

  const 保 = 体.filter(
    (e) => e.type !== 'session/title' && Number.isFinite(Number(e.data?.turn)) && Number(e.data.turn) >= 起点轮,
  )
  for (const e of 保) {
    delete e.sourceEventSeqs
    if (['user/message', 'assistant/message', 'tool/result'].includes(e.type)) e.surfaceOp = 'append'
  }
  const 全部 = [...[起, 步起, ...(系统 ? [系统] : [])], ...记忆消息, 步终, 轮终, ...保].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  过闸(id, 全部)

  const 临时 = s.文件 + '.memory'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error('宿主校验没过，没有写盘：' + String((真验 && (真验.message || 真验.错)) || 查.错 || '未知原因'))
  }
  const 备份到 = 备份(s.文件, 'before-memory')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(投影根, 'session-' + s.id + '.json')
  try {
    fs.rmSync(投影, { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '折叠记忆替换')
  const 字节 = fs.statSync(s.文件).size
  return {
    ok: true,
    模式: 'memory',
    会话: path.basename(path.dirname(s.文件)),
    备份: 备份到,
    记忆块: 记忆.length,
    总轮,
    保留轮: 保留,
    替换轮: Math.max(0, 总轮 - 保留),
    事件: 全部.length,
    字节,
    大小: (字节 / 1024 / 1024).toFixed(2) + ' MB',
  }
}

// 转移记录：把要删掉的老轮次先落成一条新会话，再从原会话里整段删掉
async function 执行转移记录(id, 保留轮数 = 20, 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 保留 = Math.max(1, Math.floor(Number(保留轮数) || 20))
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  const 起点轮 = Math.max(1, 总轮 - 保留 + 1)
  const 界 = 轮头.find((e) => Number(e.data.turn) >= 起点轮)
  if (!界 || 界 === 轮头[0]) throw new Error('保留 ' + 保留 + ' 轮就是全部 ' + 总轮 + ' 轮，没有更早的可转移')

  const 窗起 = Number(体[0].time)
  const 窗止 = Number(界.time) - 1
  const 老段 = 体.filter((e) => {
    const t = Number(e.time)
    return Number.isFinite(t) && t >= 窗起 && t <= 窗止
  })
  if (!老段.length) throw new Error('没挑出可转移的记录')

  // 新会话：id 用 原id-old-<时间>，放在同一个工作区目录下
  const 时分 = new Date()
  const 戳 = String(时分.getMonth() + 1).padStart(2, '0') + String(时分.getDate()).padStart(2, '0') + '-' + String(时分.getHours()).padStart(2, '0') + String(时分.getMinutes()).padStart(2, '0')
  const 基id = path.basename(path.dirname(s.文件)).replace(/^session-/, '')
  let 新id = 基id + '-' + 词 + '-' + 戳
  const 工作区根 = path.dirname(path.dirname(s.文件))
  for (let n = 2; fs.existsSync(path.join(工作区根, 新id)); n += 1) 新id = 基id + '-' + 词 + '-' + 戳 + '-' + n
  const 新目录 = path.join(工作区根, 新id)
  fs.mkdirSync(新目录, { recursive: true })

  const 新头 = { ...JSON.parse(JSON.stringify(头)), id: 新id, createdAt: Date.now() }
  const 原题 = (体.find((e) => e.type === 'session/title') || {}).data
  const 新题 = 原题 && typeof 原题.title === 'string' ? 原题.title + '·旧记录' : 新id
  const 新事件源 = []
  for (const e of 老段) {
    if (!['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'system/message', 'tool/call', 'tool/result'].includes(e.type)) continue
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(份.type)) 份.surfaceOp = 'append'
    新事件源.push(份)
  }
  const 新题事件 = { type: 'session/title', seq: 0, time: Date.now(), data: { title: 新题, messageSeqs: [], source: { kind: 'user' } } }
  const 新全部 = [...新事件源, 新题事件].map((e, i) => ({ ...e, seq: i }))
  重编轮步(新全部)
  const 新临时 = path.join(新目录, 'session.v4.jsonl.zstd.new')
  写会话(新头, 新全部, 新临时)
  const 新查 = await 宿主校验(新临时, 新全部.length)
  if (新查 && 新查.ok === false) {
    fs.rmSync(新临时, { force: true })
    fs.rmSync(新目录, { recursive: true, force: true })
    throw new Error('新会话没通过宿主校验，什么都没动：' + String(新查.message || 新查.错 || ''))
  }
  const 新文件 = path.join(新目录, 'session.v4.jsonl.zstd')
  fs.renameSync(新临时, 新文件)
  try {
    const 新字节 = fs.statSync(新文件).size
    void 新字节
  } catch {}

  // 再从原会话里把这一段删掉
  const { 前置, 其余 } = 重建(体, [[窗起, 窗止]], 'drop')
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临时 = s.文件 + '.moving'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error('原会话删完没通过宿主校验，原文件没动（新会话已建好：' + 新id + '）：' + String(真验.message || ''))
  }
  const 备份到 = 备份(s.文件, 'before-move')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(投影根, 'session-' + s.id + '.json')
  try {
    fs.rmSync(投影, { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '转移记录')
  const 新字节 = fs.statSync(新文件).size
  return {
    ok: true,
    模式: 'move',
    会话: path.basename(path.dirname(s.文件)),
    新会话: 新id,
    新事件: 新全部.length,
    新大小: (新字节 / 1024 / 1024).toFixed(2) + ' MB',
    备份: 备份到,
    总轮,
    保留轮: 保留,
    转移轮: Math.max(0, 总轮 - 保留),
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

// 按时间区间取账里覆盖这些 seq 的压缩记忆块
async function 取记忆块(id, 最小seq, 最大seq) {
  const 库 = ACP库
  if (!fs.existsSync(库)) return []
  let 模
  try {
    模 = await import('node:sqlite')
  } catch {
    return []
  }
  const 句柄 = new 模.DatabaseSync(库, { readOnly: true })
  try {
    for (const 键 of 账本键(id)) {
      const 行 = 句柄
        .prepare(
          'select ord, start_seq, end_seq, payload_json from blocks where session_id = ? and active = 1 and end_seq >= ? and start_seq <= ? order by ord',
        )
        .all(键, 最小seq, 最大seq)
      const 出 = []
      for (const r of 行) {
        let p = null
        try {
          p = JSON.parse(r.payload_json)
        } catch {}
        const 文 = p && typeof p.summary === 'string' ? p.summary : ''
        if (!文) continue
        const 题 = (p && typeof p.topic === 'string' && p.topic) || ''
        出.push({ 序: Number(r.ord), 题, 文 })
      }
      if (出.length) return 出
    }
    return []
  } finally {
    try {
      句柄.close()
    } catch {}
  }
}

// 把一批事件装成一条新会话（转移记录用）
async function 建新会话(源文件, 老段, 题尾巴, 工作区根, 词 = 'old') {
  const 头 = 读会话(源文件).头
  const 时分 = new Date()
  const 戳 =
    String(时分.getMonth() + 1).padStart(2, '0') +
    String(时分.getDate()).padStart(2, '0') +
    '-' +
    String(时分.getHours()).padStart(2, '0') +
    String(时分.getMinutes()).padStart(2, '0')
  const 基id = path.basename(path.dirname(源文件)).replace(/^session-/, '')
  let 新id = 基id + '-' + 词 + '-' + 戳
  for (let n = 2; fs.existsSync(path.join(工作区根, 新id)); n += 1) 新id = 基id + '-' + 词 + '-' + 戳 + '-' + n
  const 新目录 = path.join(工作区根, 新id)
  fs.mkdirSync(新目录, { recursive: true })

  const 新头 = { ...JSON.parse(JSON.stringify(头)), id: 新id, createdAt: Date.now() }
  const 原题 = 读会话(源文件).体.find((e) => e.type === 'session/title')
  const 原题字 = 原题 && 原题.data && typeof 原题.data.title === 'string' ? 原题.data.title : 新id
  const 新事件 = []
  for (const e of 老段) {
    if (
      !['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'system/message', 'tool/call', 'tool/result'].includes(
        e.type,
      )
    )
      continue
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(份.type)) 份.surfaceOp = 'append'
    新事件.push(份)
  }
  const 题事件 = {
    type: 'session/title',
    seq: 0,
    time: Date.now(),
    data: { title: 原题字 + '·' + (题尾巴 || '旧记录'), messageSeqs: [], source: { kind: 'user' } },
  }
  const 全部 = [...新事件, 题事件].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临 = path.join(新目录, 'session.v4.jsonl.zstd.new')
  写会话(新头, 全部, 临)
  const 验 = await 宿主校验(临, 全部.length)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    fs.rmSync(新目录, { recursive: true, force: true })
    throw new Error('新会话没通过宿主校验，什么都没动：' + String(验.message || 验.错 || ''))
  }
  const 实 = path.join(新目录, 'session.v4.jsonl.zstd')
  fs.renameSync(临, 实)
  return { 新id, 新文件: 实, 事件: 全部.length, 字节: fs.statSync(实).size }
}

// 转移记录（按勾选的段）：先把这些段搬进新会话，再从原会话删掉
// 复制记录：把选中的这段原样复制成一条新会话，原会话完全不动（不备份、不重置账、不用重启）
async function 执行复制区间(id, 区间表) {
  const s = 找会话(id)
  const { 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  const 在里 = (e) => 区间.some(([a, b]) => Number(e.time) >= a && Number(e.time) <= b)
  const 老段 = 体.filter(在里)
  if (!老段.length) throw new Error('勾选的段里没有可复制的记录')
  const 新 = await 建新会话(s.文件, 老段, '副本', path.dirname(path.dirname(s.文件)), 'copy')
  return { 新id: 新.新id, 事件: 新.事件 ?? null, 字节: 新.字节 ?? null, 原会话未改动: true }
}

async function 执行转移区间(id, 区间表, 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  const 在里 = (e) => 区间.some(([a, b]) => Number(e.time) >= a && Number(e.time) <= b)
  const 老段 = 体.filter(在里)
  if (!老段.length) throw new Error('勾选的段里没有可转移的记录')

  const 新 = await 建新会话(s.文件, 老段, '旧记录', path.dirname(path.dirname(s.文件)))

  const { 前置, 其余 } = 重建(体, 区间, 'drop')
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临 = s.文件 + '.moving'
  写会话(头, 全部, 临)
  const 查 = await 校验(临)
  const 验 = await 宿主校验(临, 查.事件)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    throw new Error('原会话删完没通过宿主校验，原文件没动（新会话已建好：' + 新.新id + '）：' + String(验.message || ''))
  }
  const 备份到 = 备份(s.文件, 'before-move')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临, s.文件)
  try {
    fs.rmSync(path.join(投影根, 'session-' + s.id + '.json'), { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '转移记录')
  return {
    ok: true,
    模式: 'move',
    会话: path.basename(path.dirname(s.文件)),
    新会话: 新.新id,
    新事件: 新.事件,
    新大小: (新.字节 / 1024 / 1024).toFixed(2) + ' MB',
    备份: 备份到,
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

// 折叠记忆（按勾选的段）：删掉这些段，换成账里覆盖它们的压缩记忆
async function 执行记忆区间(id, 区间表, 记忆源 = '', 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  // 账里块的 seq 是 ACP 自己的编号，跟会话事件 seq 不在一个空间，没法逐段对应。
  // 所以这里的语义是：把「从最早一直到你勾的最后一行为止」整段换成账里的压缩记忆，勾选之后的内容原样保留。
  const 界 = Math.max(...区间.map(([, b]) => Number(b)))
  const 命中 = 体.filter((e) => Number(e.time) <= 界)
  if (!命中.length) throw new Error('勾选的段前面没有可替换的记录')
  const 记忆 = await 取压缩记忆(记忆源 || id)
  if (!记忆.length) {
    throw new Error('这个会话在压缩插件里没有记忆块（可能是新会话、或账已被重置）。想留住它们就用「转移记录」。')
  }

  const { 前置, 其余 } = 重建(体, [[0, 界]], 'drop')
  const 基时 = Number(前置[0] && 前置[0].time) || Date.now()
  const 源系统 = 体.find((e) => e.type === 'system/message')
  const 记忆消息 = 记忆.map((m, i) => ({
    type: 'user/message',
    seq: 0,
    time: 基时 + i,
    data: {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: '【压缩记忆 ' + (i + 1) + '/' + 记忆.length + '｜' + (m.题 || '第 ' + m.序 + ' 块') + '】\n' + m.文 }],
      source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Etc/GMT-8' },
    },
    surfaceOp: 'append',
  }))
  const 起 = { type: 'turn/start', seq: 0, time: 基时, data: { turn: 1 } }
  const 步起 = { type: 'step/start', seq: 0, time: 基时, data: { turn: 1, step: 1 } }
  const 系统 = 源系统 ? { ...JSON.parse(JSON.stringify(源系统)), seq: 0, data: { ...JSON.parse(JSON.stringify(源系统.data)), turn: 1, step: 1 } } : null
  if (系统) delete 系统.sourceEventSeqs
  const 步终 = { type: 'step/end', seq: 0, time: 基时 + 记忆.length + 1, data: { turn: 1, step: 1 } }
  const 轮终 = { type: 'turn/end', seq: 0, time: 基时 + 记忆.length + 2, data: { turn: 1, reason: { kind: 'completed' } } }

  const 全部 = [...[起, 步起, ...(系统 ? [系统] : [])], ...记忆消息, 步终, 轮终, ...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  for (const e of 全部) delete e.sourceEventSeqs
  重编轮步(全部)
  过闸(id, 全部)

  const 临 = s.文件 + '.memory'
  写会话(头, 全部, 临)
  const 查 = await 校验(临)
  const 验 = await 宿主校验(临, 查.事件)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    throw new Error('宿主校验没过，没有写盘：' + String(验.message || 验.错 || 查.错 || ''))
  }
  const 备份到 = 备份(s.文件, 'before-memory')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临, s.文件)
  try {
    fs.rmSync(path.join(投影根, 'session-' + s.id + '.json'), { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '折叠记忆')
  return {
    ok: true,
    模式: 'memory',
    会话: path.basename(path.dirname(s.文件)),
    记忆块: 记忆.length,
    备份: 备份到,
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

async function 执行清旧轮(id, 保留轮数 = 10, 模式 = 'tools', 强制 = false) {
  await 挡活会话(id, 强制)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 保留 = Math.max(0, Math.floor(Number(保留轮数) || 0))
  const 略 = 模式 === 'drop' ? 'drop' : 'tools'
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  const 起点轮 = 总轮 - 保留 + 1
  const 界 = 轮头.find((e) => Number(e.data.turn) >= 起点轮)
  if (!界 || 界 === 轮头[0]) throw new Error(`保留 ${保留} 轮就是全部 ${总轮} 轮，没有更早的可清`)
  const 起时间 = 体[0].time
  const 到时间 = 界.time - 1
  const { 前置, 其余 } = 重建(体, [[起时间, 到时间]], 略)
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  if (略 === 'drop') 重编轮步(全部)
  const 临时 = s.文件 + '.cleaning'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error(`宿主校验没过：${真验.message || '未知'}`)
  }
  const 原字节 = fs.statSync(s.文件).size
  const 备份名 = 备份(s.文件, 'before-clean-old')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (fs.existsSync(投影)) fs.rmSync(投影, { force: true })
  标待重启(s.id, '清旧轮次')
  try { 重置折叠账(s.id, 'clean-old') } catch {}
  return {
    备份: 备份名,
    剩余事件: 查.事件,
    总轮,
    保留轮: 保留,
    清了轮: 总轮 - 保留,
    模式: 略,
    原字节,
    新字节: fs.statSync(s.文件).size,
  }
}

// 同一个会话的其它备份（不含刚试过的那一份），按修改时间从新到旧
function 同会话备份(id, 排除名) {
  const 前缀 = `session-${String(id).replace(/^session-/, '')}.session.v4.jsonl.zstd.`
  return fs
    .readdirSync(备份根)
    .filter((n) => n.startsWith(前缀) && n !== 排除名)
    .map((n) => ({ n, t: fs.statSync(path.join(备份根, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map(({ n }) => path.join(备份根, n))
}

async function 还原(名, 强制 = false) {
  const 文件 = path.join(备份根, 名)
  if (!fs.existsSync(文件)) throw new Error(`找不到备份 ${名}`)
  const id = String(名).split('.session.v4.jsonl.zstd')[0].replace(/^session-/, '')
  if (!id) throw new Error(`这个备份是旧格式，名字里没有会话号，认不出属于哪个会话：${名}`)
  await 挡活会话(id, 强制)
  const s = 找会话(id)

  // 备份本身也可能是坏的（备份的是一份已经坏掉的会话），所以先验一遍；
  // 不通过就按时间往下一份旧备份退，直到有一份宿主能接受。
  const 候选 = [文件, ...同会话备份(s.id, 名)]
  let 用 = null
  for (const 备 of 候选) {
    const 验 = await 宿主校验(备)
    if (验 && 验.ok) {
      用 = 备
      break
    }
    if (验) 记(`还原：${path.basename(备)} 没通过校验（${验.message}），试下一份`)
  }
  if (!用) {
    throw new Error('这个会话的所有备份都没通过宿主校验，没法还原。把这句话发我，我来修。')
  }
  备份(s.文件, 'before-restore')
  fs.copyFileSync(用, s.文件)
  const 投影 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (fs.existsSync(投影)) fs.rmSync(投影, { force: true })
  标待重启(s.id, '还原')
  try { 重置折叠账(s.id, 'restore') } catch {}
  return { 还原自: path.basename(用), 到: s.文件, 字节: fs.statSync(s.文件).size }
}

// 对任意文件跑一遍「清除」，写到 <文件>.out，只做校验，不动原文件（给自己和测试用）
export async function 试清除(文件, 键表) {
  const { 头, 体 } = 读会话(文件)
  const 段 = 分段(体)
  const 目标 = [...new Set(键表.map(Number))].filter((n) => n >= 0 && n < 段.length)
  const 范围 = 目标.map((n) => [段[n].起, 段[n].到])
  const { 前置, 其余 } = 重建(体, 范围)
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  const 出口 = 文件 + '.out'
  写会话(头, 全部, 出口)
  const 查 = await 校验(出口)
  return { 出口, 问题: 查.问题, 事件: 查.事件, 段: 段.length, 删了: 目标.length, 字节: fs.statSync(出口).size }
}

export const __test = { 用户话, 过闸, 估体tokens, 有折叠账, 账在用的tokens, 取压缩记忆, 执行记忆替换, 执行转移记录, 执行记忆区间, 执行转移区间, 执行复制区间, 列备份, 分析文件, 试清除, 统计注入, 折叠注入, 校验, 分段, 列会话, 读会话, 写会话, 读首句, 读标题, 读轮数, 重建, 重编轮步, 读占用, 宿主校验, 正在用, 挡活会话, 标待重启, 读待重启, 执行清除区间, 执行清旧轮, 执行去重, 还原, 构提问, 写表模板, 解析表文件, 表文件 }

function 读体(req) {  return new Promise((好, 坏) => {
    let 数 = ''
    req.on('data', (c) => {
      数 += c
      if (数.length > 1e6) 坏(new Error('请求体太大'))
    })
    req.on('end', () => {
      try {
        好(数 ? JSON.parse(数) : {})
      } catch (e) {
        坏(e)
      }
    })
    req.on('error', 坏)
  })
}

// 把内部异常翻成「发生了什么 + 你该怎么做」。面板直接把这两段话显示给用户。
function 用户话(e) {
  const m = e instanceof Error ? e.message : String(e)
  const 含 = (...词) => 词.some((w) => m.includes(w))

  if (含('宿主的会话接口', '等 DSH 重启完再用它')) {
    return {
      说: '现在没法确认这个会话是不是正开着。为了不弄坏它，这次没有动文件。',
      下一步: '把 DSH 完全关掉再打开（不是刷新页面），然后回到这个面板再点一次。',
    }
  }
  if (含('正在宿主里跑着', '刚打开过')) {
    return {
      说: '这个会话现在开着，清理会跟它抢着写同一份日志，所以这次没有动文件。',
      下一步: '先切到别的会话、或者把那个窗口关掉，再回来清。',
    }
  }
  if (含('还没清够')) {
    return {
      说: m.replace(/^还没清够：/, '清完之后还是太大：'),
      下一步: '在表格里多勾几行、一次清掉更多，或者分两次清。目标是压到 78 万 token 以下。',
    }
  }
  if (含('没有勾选', '先勾几段')) {
    return { 说: '这次没有选中任何要清理的内容。', 下一步: '在表格最左边勾上想清理的那几行，再点下面的按钮。' }
  }
  if (含('没有对应块', '没有记忆块')) {
    return {
      说: '这条会话在压缩插件里还没有可用的压缩记忆。',
      下一步: '改用「转移记录」把这几段搬去新会话，或者用「工具结果」清掉工具输出。',
    }
  }
  if (含('校验', 'corrupt')) {
    return {
      说: '删完的文件没通过宿主的格式检查，所以没有替换原文件。',
      下一步: '换个方式清一次（比如先用「工具结果」）；反复失败就把这段提示发给我。',
    }
  }
  if (含('会话日志里只有表头', '读出来是空')) {
    return { 说: '这条会话的日志现在读不出内容。', 下一步: '过几十秒再点一次；还不行就先重启 DSH。' }
  }
  if (含('EBUSY', 'EPERM', 'EACCES')) {
    return { 说: '文件正被别的程序占着，写不进去。', 下一步: '关掉 DSH 再操作；如果还不行，把这段提示发给我。' }
  }
  if (含('ENOENT')) {
    return { 说: '找不到对应的文件（会话或备份）。', 下一步: '刷新一下面板；如果刚在别处删过文件，重启 DSH 让列表重新读一遍。' }
  }
  return { 说: '这次没能完成：' + m, 下一步: '换个操作再试一次；如果反复失败，把这段提示发给我。' }
}

function 记(行) {
  try {
    fs.appendFileSync(日志文件, `${new Date().toISOString()} ${行}\n`)
  } catch {}
}

export async function 处理请求(req, res) {
  {
      const 回 = (码, 对象) => {
        res.writeHead(码, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(对象))
      }
      try {
        const u = new URL(req.url, 'http://x')
        // 宿主按前缀挂载，pathname 会带着 /dsh-context-cleaner；本地服务则是裸路径
        let 径 = u.pathname
        if (径 === '/dsh-context-cleaner') 径 = '/'
        else if (径.startsWith('/dsh-context-cleaner/')) 径 = 径.slice('/dsh-context-cleaner'.length)
        try { 径 = decodeURI(径) } catch {}
        if (req.method === 'GET' && 径 === '/debug') {
          const 会话API2 = 会话API
          const 名 = (o) => (o ? Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((k) => typeof o[k] === 'function') : [])
          const 全 = (会话API2 && typeof 会话API2.list === 'function') ? 会话API2.list() : []
          const 条 = Array.isArray(全) ? 全 : []
          const 结果 = {
            有接口: !!会话API2,
            服务方法: 名(会话API2),
            存活条数: 条.length,
            存活项: 条.slice(0, 6).map((e) => String(e && (e.id ?? e.header?.id))),
            逐个: [],
          }
          for (const s of 列会话()) {
            const 真 = 'session-' + s.id
            let 有 = null
            try { 有 = !!(会话API2.get && (await 会话API2.get(真))) } catch (e) { 有 = '错:' + String(e.message || e) }
            结果.逐个.push({ id: s.id, 标题: s.标题 || s.首句 || '', get: 有 })
          }
          return 回(200, 结果)
        }

        if (req.method === 'GET' && 径 === '/sessions') {
          const 等重启 = 读待重启()
          const 列表 = 列会话()
            .map((s) => ({
              id: s.id,
              标题: s.标题,
              首句: s.首句,
              改动: s.改动,
              字节: s.字节,
              说明: s.说明,
              工作区: s.工作区,
              占用: s.占用,
              占比: s.占比,
              账算: s.账算,
              账token: s.账token,
              初算: s.初算,
              折叠账: s.折叠账,
              轮数: s.轮数,
              待重启: 等重启[s.id]?.动作 || '',
            }))
            .sort((a, b) => b.改动 - a.改动)
          return 回(200, { ok: true, 窗口: 窗口token, 会话: 列表 })
        }
        if (req.method === 'GET' && 径 === '/analyze') return 回(200, { ok: true, ...分析(u.searchParams.get('sid')) })
        if (req.method === 'GET' && 径 === '/backups') {
          const 用 = u.searchParams.get('sid')
          const 全 = 列备份()
          return 回(200, { ok: true, 备份: 用 ? 全.filter((b) => b.名.includes(用.replace(/^session-/, ''))) : 全 })
        }
        if (req.method === 'GET' && 径 === '/inject') {
          const s = 找会话(u.searchParams.get('sid'))
          const { 体 } = 读会话(s.文件)
          return 回(200, { ok: true, ...统计注入(体) })
        }
        if (req.method === 'POST' && 径 === '/ask') {
          const b = await 读体(req)
          const s = 找会话(b.sid)
          // 清过/还原过的会话要等宿主重启才安全，这期间连投递也别做
          const 待 = 读待重启()[String(s.id).replace(/^session-/, '')]
          if (待) return 回(409, { ok: false, 错: `这个会话${待.动作 || '清'}过了，等 DSH 重启完再用它` })
          // 插件先切好粗颗粒的段，再放一张空表；会话按工作内容自己定行，填进表里
          const 分析 = 分析文件(s.文件)
          // 先放一张空表给会话填，再让它按表填；填完面板读这个文件
          const 表路径 = 表文件(s.文件)
          if (!b.文本) 写表模板(s.标题 || s.id, 表路径)
          const 题 = b.文本 ? String(b.文本) : 构提问(分析.时间线, s.标题 || s.id, 表路径, 分析.总token)
          // 先走宿主 RPC：真的把这句话发进那个会话并等它回话；拿不到 API 才退回写文件
          const 走宿主 = await 宿主投问(s.文件, 题, req)
          if (走宿主) {
            // 表由会话写进文件，面板读回来；文件没填出东西就把原文交给用户看
            const 解析 = 解析表文件(表路径, 分析.段, new Date(分析.段[0]?.起ms || Date.now()).getFullYear())
            // 服务端先存一份：浏览器中途切走、请求断了也不会丢，回来一问就有
            if (解析?.表?.length) {
              写表视图({
                sid: s.id,
                会话名: s.标题 || s.id,
                表: 解析.表,
                建议: 解析.建议 || '',
                原文: 走宿主.文本 || '',
                时: Date.now(),
              })
            }
            return 回(200, {
              ok: true,
              ...走宿主,
              事件: 0,
              窗口: 分析.窗口,
              段数: 分析.段.length,
              表: 解析?.表 || null,
              建议: 解析?.建议 || '',
              表文件: 表路径,
            })
          }
          // 不再退回「往文件里塞一条 user/message」：那会跟正在运行的宿主抢同一个文件，之前把会话写坏过
          记(`/ask 没投出去：host=${req?.headers?.host || ''} cookie=${req?.headers?.cookie ? '有' : '没有'} 会话控=${会话控 ? '有' : '没有'}`)
          return 回(503, { ok: false, 错: '宿主会话接口不可用，暂时不能投递（不走改文件那条路了）' })
        }
        if (req.method === 'GET' && 径 === '/table') {
          const 存 = 读表视图()
          if (存 && Array.isArray(存.表) && 存.表.length) return 回(200, { ok: true, 表: 存 })
          return 回(200, { ok: true, 表: 恢复表视图() })
        }
        if (req.method === 'POST' && 径 === '/table') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...写表视图(b) })
        }
        if (req.method === 'POST' && 径 === '/dedupe') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...(await 执行去重(b.sid, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/clean') {
          const b = await 读体(req)
          const 模式 = ['tools', 'drop', 'memory', 'move', 'copy'].includes(b.模式) ? b.模式 : 'all'
          if (模式 === 'memory') return 回(200, { ok: true, ...(await 执行记忆区间(b.sid, b.区间, undefined, !!b.强制)) })
          if (模式 === 'move') return 回(200, { ok: true, ...(await 执行转移区间(b.sid, b.区间, !!b.强制)) })
          if (模式 === 'copy') return 回(200, { ok: true, ...(await 执行复制区间(b.sid, b.区间)) })
          const 区间 = Array.isArray(b.区间) ? b.区间 : []
          if (!区间.length) return 回(400, { ok: false, 错: '没有给时间段（区间）' })
          return 回(200, { ok: true, 模式, ...(await 执行清除区间(b.sid, 区间, 模式, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/clean-old') {
          const b = await 读体(req)
          if (b.模式 === 'memory') {
            return 回(200, { ok: true, ...(await 执行记忆替换(b.sid, b.保留轮数, undefined, !!b.强制)) })
          }
          if (b.模式 === 'move') {
            return 回(200, { ok: true, ...(await 执行转移记录(b.sid, b.保留轮数, !!b.强制)) })
          }
          return 回(200, { ok: true, ...(await 执行清旧轮(b.sid, b.保留轮数, b.模式, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/restore') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...(await 还原(b.名, !!b.强制)) })
        }
        return 回(404, { ok: false, 错: `未知路径 ${u.pathname}` })
      } catch (e) {
        const 话 = 用户话(e)
        try {
          记(`${req.method} ${u.pathname} 失败：${e instanceof Error ? e.message : String(e)}`)
        } catch {}
        const 体 = { ok: false, 错: 话.说, 下一步: 话.下一步 }
          if (e && e.活会话) 体.活着 = true
          return 回(500, 体)
      }
  }
}

// ---- ctx_dedupe 工具（原 dsh-ctx-dedupe 的功能，2026-11-17 并进来） ----
// scan：只统计重复系统注入；apply：折叠后另存一份 <会话>.staged.zstd，不覆盖原文件。
function 最近会话() {
  try {
    return 列会话()[0]?.文件 || ''
  } catch {
    return ''
  }
}

function 注册去重工具(ctx) {
  if (!ctx?.tools?.register) {
    记('没有 tools 服务，ctx_dedupe 跳过')
    return
  }
  ctx.tools.register({
    name: 'ctx_dedupe',
    description:
      '把会话日志里重复注入的「记忆快照 / 运行上下文 / system-reminder / 系统提醒」折叠成一行（离线去重）。\n'
      + 'action=scan 只统计不动文件；action=apply 生成折叠后的副本（<会话>.staged.zstd），不覆盖正式文件。\n'
      + '同一个面板在 Web UI 侧栏「清上下文」里，带备份与还原。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'apply'], description: 'scan 只统计；apply 生成副本' },
        sessionPath: { type: 'string', description: '可选：指定 session.v4.jsonl.zstd 路径，默认取最近写入的会话' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const 动作 = String(args?.action || 'scan').trim()
      const 文件 = args?.sessionPath ? String(args.sessionPath) : 最近会话()
      if (!文件 || !fs.existsSync(文件)) return '找不到会话日志文件。可以手动传 sessionPath。'
      const { 头, 体 } = 读会话(文件)
      const 统 = 统计注入(体)
      if (动作 === 'scan') {
        const 行 = 统.清单.map((x) => `- ${x.类}：${x.处数} 处，可省 ${Math.round(x.可省字 / 1000)}k 字`).join('\n')
        return `扫描完成（${path.basename(path.dirname(文件))}）\n事件 ${体.length} 条，重复注入 ${统.总处} 处，可省约 ${Math.round(统.可省字 / 1000)}k 字（留最新 ${统.保留份数} 份）\n${行}`
      }
      const { 体: 新体, 折叠, 省字 } = 折叠注入(体)
      if (!折叠) return '没有可折叠的重复注入。'
      const 规整 = 重建(新体, [])
      const 全部 = [...规整.前置, ...规整.其余].map((e, i) => ({ ...e, seq: i }))
      const 出 = `${文件}.staged.zstd`
      写会话(头, 全部, 出)
      const 查 = await 宿主校验(出, 全部.length)
      if (查 && 查.ok === false) {
        try {
          fs.rmSync(出, { force: true })
        } catch {}
        return `宿主校验没过，副本已删：${查.message || '未知'}`
      }
      return `已生成去重副本（没有动原文件）：${出}\n折叠 ${折叠} 处，省约 ${Math.round(省字 / 1000)}k 字，事件 ${全部.length} 条，宿主校验通过。\n要用的话走面板「折叠重复注入」，它会自动备份并替换。`
    },
  })
}

export function apply(ctx) {
  记('apply 被调用')
  宿主ctx = ctx
  try {
    会话控 = ctx.get('sessionController') ?? null
    记(`sessionController: ${会话控 ? '有' : '没有'} / resolveAgent=${typeof 会话控?.resolveAgent}`)
    会话API = ctx.get('sessions') ?? null
    记(`sessions API: ${会话API ? Object.keys(会话API).slice(0, 12).join(',') : '没有'}`)
    记(`sessions 方法: ${会话API ? Object.getOwnPropertyNames(Object.getPrototypeOf(会话API)).join(',') : '无'}`)
    记(`prompt/history: ${typeof 会话API?.prompt}/${typeof 会话API?.history}`)
    void (async () => {
      try {
        const 表 = await 会话API.list()
        const 首 = Array.isArray(表) ? 表[0] : (表?.items ?? [])[0]
        记(`会话条目 keys: ${首 ? Object.keys(首).slice(0, 14).join(',') : '空'}`)
        记(`会话条目 方法: ${首 ? Object.getOwnPropertyNames(Object.getPrototypeOf(首)).slice(0, 24).join(',') : '空'}`)
      } catch (e) {
        记(`list 出错：${String(e && e.message)}`)
      }
    })()
    const 网关 = ctx.get('typertGateway') ?? null
    记(`typertGateway: ${网关 ? Object.keys(网关).slice(0, 20).join(',') : '没有'}`)
    const 连接 = ctx.get('connection') ?? null
    记(`connection: ${连接 ? Object.keys(连接).slice(0, 20).join(',') : '没有'}`)
  } catch (e) {
    记(`拿 sessions 出错：${String(e && e.message)}`)
  }
  ctx.effect(() => {
    记('effect 执行，注册路由')
    return ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-context-cleaner',
      handler: 处理请求,
    })
  })
  try {
    注册去重工具(ctx)
  } catch (e) {
    记(`注册 ctx_dedupe 出错：${String(e && e.message)}`)
  }
  void 校验器
}
