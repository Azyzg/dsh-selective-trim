// sessions
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { 估算, 估算tokens, 读占用, 读轮数 } from './analysis.mjs'
import { 会话根, 备份根, 家, 投影根, 窗口token } from './base.mjs'
import { 帧边界, 摘要, 文本, 读会话 } from './io.mjs'
import { 有折叠账, 账在用的tokens } from './ledger.mjs'

export function 正文字数(e) {
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

export function 读头(文件) {
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

export function 读首句(文件) {
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
export function 读标题(id) {
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
export function 从文件读标题(文件) {
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
export function 面板会话() {
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
export function 解码根(名) {
  const 全 = String(名)
    .replace(/^--/, '')
    .replace(/--$/, '')
    .replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/-/g, '\\')
  return 全
}

export function 短根(根) {
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
export function 归一(根) {
  const s = String(根).replace(/[\\/]+$/, '')
  const m = /^([A-Za-z])\\(.*)$/.exec(s)
  return (m ? `${m[1]}:\\${m[2]}` : s).toLowerCase()
}

// 已经归档的会话（侧栏里收进「已归档」）。workspace.json 的 global.archivedSessionIds 是权威名单
export function 归档集合() {
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

// 不套任何过滤（归档、空会话、无轮次都不看）的原始索引：给「找会话」兜底用。
// 面板只列「能点得动」的会话，但清理/还原/复制可能要按 id 直接找到被过滤掉的那条。
export function 全索引() {
  const 索引 = new Map()
  if (!fs.existsSync(会话根)) return 索引
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
  return 索引
}

export function 列会话() {
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

export function 找会话(id) {
  const 干净 = String(id || '').replace(/^session-/, '')
  if (!干净) throw new Error('没拿到会话 id：面板上的「当前会话」丢了，回列表重选一次再操作')
  const 直 = 列会话().find((s) => s.id === 干净)
  if (直) return 直
  // 兜底：被 列会话 过滤掉的（归档、轮次为 0）也要能按 id 找到——面板上残着旧的
  // 「当前会话」时就会走到这里，不该直接报「找不到会话」。
  const 全 = 全索引()
  const 做 = (真id, 命中) => {
    const st = fs.statSync(命中.文件)
    return {
      id: 真id,
      文件: 命中.文件,
      说明: 短根(命中.根),
      工作区: '',
      在面板: false,
      标题: 从文件读标题(命中.文件),
      首句: '',
      改动: st.mtimeMs,
      字节: st.size,
      占用: 0,
      占比: 0,
      账算: false,
      账token: 0,
      初算: 0,
      轮数: 读轮数(命中.文件),
      折叠账: 有折叠账(真id),
    }
  }
  if (全.has(干净)) return 做(干净, 全.get(干净))
  // 前缀只当「传了个完整 id 的唯一前缀」用：bili-whale 这种既短又是别人前缀的，
  // 绝不能匹配到 bili-whale-1120 —— 认错会话会写到别人文件里去。
  const 前 = [...全.keys()].filter((k) => k.startsWith(干净) && k !== 干净)
  if (干净.length >= 6 && 前.length === 1) return 做(前[0], 全.get(前[0]))
  // 多个候选时优先「干净 + 36 位 uuid」那条主线会话；-copy-MMDD-HHMM 这类副本排后面
  if (干净.length >= 6) {
    const 主 = 前.filter((k) => /^([0-9a-f]{8}-)?[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k.slice(干净.length + 1)))
    if (主.length === 1) return 做(主[0], 全.get(主[0]))
  }
  throw new Error(`找不到会话 ${id}`)
}

export function 概要(文件) {
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
export function 估算缓存路径() {
  return path.join(备份根, '估算.json')
}
