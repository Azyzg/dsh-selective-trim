// transfer
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { 备份, 挡活会话, 标待重启 } from './backup.mjs'
import { 投影根 } from './base.mjs'
import { 重建, 重编轮步 } from './clean.mjs'
import { 整理副本, 整轮片段, 规整整轮 } from './copyfix.mjs'
import { 写会话, 宿主校验, 校验, 读会话 } from './io.mjs'
import { 过闸, 重置折叠账 } from './ledger.mjs'
import { 找会话 } from './sessions.mjs'
import { 合法预设 } from './presets.mjs'

export async function 执行转移记录(id, 保留轮数 = 20, 跳过活检查 = false, 预设 = '') {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 保留 = Math.max(1, Math.floor(Number(保留轮数) || 20))
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  // 边界按「从末尾数第 N 个 turn/start」定位，切分用 seq：时间乱序时按时间切会切出残轮
  const 界 = 轮头[轮头.length - 保留]
  if (!界 || 界 === 轮头[0]) throw new Error('保留 ' + 保留 + ' 轮就是全部 ' + 轮头.length + ' 轮，没有更早的可转移')
  const 界序 = Number(界.seq)
  const 老段 = 体.filter((e) => Number(e.seq) < 界序)
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
  const { 前置, 其余 } = 重建(体, [], 'drop', [Number(体[0].seq), 界序 - 1])
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  钉头轮步(全部)
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
// 新会话建好之后要登记到侧栏：宿主只按 workspace.json 里各工作区的 sessionIds 列会话，
// 光把目录写进磁盘、不登记的话重启也看不见（老大 2026-11-26 报过「复制完重启没看到新会话」）。
// 源会话在不在 sessionIds 里决定了它属于哪个工作区；找不到就说明它在「未分组」，那种会自动出现，不用登记。
export function 登记到侧栏(源目录名, 新id) {
  const 短 = (s) => String(s || '').replace(/^session-/, '')
  try {
    const p = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    if (!fs.existsSync(p)) return { ok: false, 说: '没有 workspace.json' }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const 表 = j?.tables?.workspaces
    if (!表) return { ok: false, 说: 'workspace.json 里没有 workspaces' }
    const 源 = 短(源目录名)
    for (const k of Object.keys(表)) {
      const 列 = Array.isArray(表[k]?.sessionIds) ? 表[k].sessionIds : null
      if (!列) continue
      const i = 列.findIndex((x) => 短(x) === 源)
      if (i < 0) continue
      if (列.some((x) => 短(x) === 短(新id))) return { ok: true, 说: '已经在了' }
      const 插 = 短(新id) === String(新id) ? 新id : 新id
      列.splice(i + 1, 0, 插)
      const 临 = p + '.registering'
      fs.writeFileSync(临, JSON.stringify(j, null, 2))
      fs.renameSync(临, p)
      return { ok: true, 工作区: k, 说: '已登记' }
    }
    return { ok: true, 说: '源会话不在任何工作区的列表里（未分组），不用登记' }
  } catch (e) {
    return { ok: false, 说: String(e.message || e) }
  }
}

// 勾选的时间区间常切在半轮中间：原来保留原轮号，新文件里没打开的轮就对不上，
// 宿主报 assistant/message does not match an open turn and step（老大 2026-11-26 复制完打不开）。
// 这里不信原轮号，按事件顺序重建骨架：缺 step/start 补一个，缺 step/end、turn/end 就收口，
// 再给带轮号的事件统一编号。
// 区间边界会把 tool/call 和它的 tool/result 切开：只剩调用没有结果时宿主报
// step/end leaves unresolved tool call …, 只剩结果又成了孤儿。两边必须成对保留。
export function 只留成对工具(事件) {
  const 调 = new Set()
  const 果 = new Set()
  for (const e of 事件) {
    if (e.type === 'tool/call' && e.data?.callId) 调.add(String(e.data.callId))
    if (e.type === 'tool/result') {
      const id = e.data?.toolCallId ?? e.data?.message?.toolCallId
      if (id) 果.add(String(id))
    }
  }
  return 事件.filter((e) => {
    if (e.type === 'tool/call') return 果.has(String(e.data?.callId || ''))
    if (e.type === 'tool/result') {
      const id = e.data?.toolCallId ?? e.data?.message?.toolCallId
      return 调.has(String(id || ''))
    }
    return true
  })
}

export function 补齐轮步(事件) {
  const 出 = []
  let 轮 = 0
  let 步 = 0
  let 开轮 = false
  let 开步 = false
  const 关步 = () => {
    if (!开步) return
    出.push({ type: 'step/end', seq: 0, time: 出[出.length - 1]?.time || Date.now(), data: { turn: 轮, step: 步 } })
    开步 = false
  }
  const 关轮 = () => {
    关步()
    if (!开轮) return
    出.push({ type: 'turn/end', seq: 0, time: 出[出.length - 1]?.time || Date.now(), data: { turn: 轮, reason: { kind: 'completed' } } })
    开轮 = false
  }
  const 开新步 = (时) => {
    步 += 1
    开步 = true
    出.push({ type: 'step/start', seq: 0, time: 时, data: { turn: 轮, step: 步 } })
  }
  for (const 原 of 事件) {
    const e = JSON.parse(JSON.stringify(原))
    const 时 = Number(e.time) || Date.now()
    if (e.type === 'turn/start') {
      关轮()
      轮 += 1
      步 = 0
      开轮 = true
      e.data = { ...(e.data || {}), turn: 轮 }
      delete e.data.step
      出.push(e)
      continue
    }
    if (e.type === 'turn/end') {
      关轮()
      continue
    }
    if (e.type === 'step/start') {
      if (!开轮) {
        轮 += 1
        开轮 = true
      }
      开步 = false
      开新步(时)
      continue
    }
    if (e.type === 'step/end') {
      关步()
      continue
    }
    if (!['user/message', 'assistant/message', 'system/message', 'tool/call', 'tool/result', 'developer/message'].includes(e.type)) {
      出.push(e)
      continue
    }
    // 带轮号的类型必须有开着的步；没有就现开一个
    if (Number.isFinite(Number(e.data?.turn)) || ['assistant/message', 'tool/call', 'tool/result', 'system/message'].includes(e.type)) {
      if (!开轮) {
        轮 += 1
        开轮 = true
        出.push({ type: 'turn/start', seq: 0, time: 时, data: { turn: 轮 } })
      }
      if (!开步) 开新步(时)
      e.data = { ...(e.data || {}), turn: 轮, step: 步 }
    }
    出.push(e)
  }
  关轮()
  return 出
}

// 受保护头必须落在第一个开着的轮/步里：重编轮步会给消息重新编号，系统头常常被
// 算成别的轮（实测 turn 9 / step 1），宿主于是报 system/message does not match an open turn。
export function 钉头轮步(全) {
  const 轮 = 全.find((e) => e.type === 'turn/start')
  const 步 = 全.find((e) => e.type === 'step/start')
  const 头 = 全.find((e) => e.type === 'system/message')
  if (轮 && 步 && 头) {
    头.data = { ...(头.data || {}) }
    头.data.turn = 轮.data.turn
    头.data.step = 步.data.step
  }
  return 全
}

export async function 建新会话(源文件, 老段, 题尾巴, 工作区根, 词 = 'old', 预设 = '', 整理 = true) {
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
  // 新会话的 agent preset：调用方指定优先，否则沿用源会话
  const 选预设 = (await 合法预设(预设)) || String(头.agentPreset || '')
  if (选预设) 新头.agentPreset = 选预设
  const 原题 = 读会话(源文件).体.find((e) => e.type === 'session/title')
  const 原题字 = 原题 && 原题.data && typeof 原题.data.title === 'string' ? 原题.data.title : 新id
  const 源体 = 读会话(源文件).体
  const 系统头 = 源体.find((e) => e.type === 'system/message') || null
  const 允许 = ['user/message', 'assistant/message', 'system/message', 'tool/call', 'tool/result']
  const 老系列 = 老段.filter((e) => 允许.includes(e.type))
  // 骨架和工具两侧在这里统一整理：搬出来的片段本来就没有完整轮/步，直接拼会过不了宿主校验。
  const 全部 = 整理 ? 整理副本(老系列, 系统头) : 规整整轮(老段, 系统头)
  const 题事件 = {
    type: 'session/title',
    seq: 0,
    time: Date.now(),
    data: { title: 原题字 + '·' + (题尾巴 || '旧记录'), messageSeqs: [], source: { kind: 'user' } },
  }
  全部.push({ ...题事件, seq: 全部.length })
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
  const 登记 = 登记到侧栏(path.basename(path.dirname(源文件)), 新id)
  return { 新id, 新文件: 实, 事件: 全部.length, 字节: fs.statSync(实).size, 登记 }
}

// 转移记录（按勾选的段）：先把这些段搬进新会话，再从原会话删掉
// 复制记录：把选中的这段原样复制成一条新会话，原会话完全不动（不备份、不重置账、不用重启）
export async function 执行复制区间(id, 区间表, 预设 = '') {
  const s = 找会话(id)
  const { 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  // 按整轮取：勾选的时段多半从半轮中间开始，按事件过滤会把同一轮劈成两半，
  // 工具调用只剩一侧，整理时就连人话一起丢。整轮取完骨架原样保留，什么都不用猜。
  const 老段 = 整轮片段(体, 区间)
  if (!老段.length) throw new Error('勾选的段里没有可复制的记录')
  const 新 = await 建新会话(s.文件, 老段, '副本', path.dirname(path.dirname(s.文件)), 'copy', 预设, false)
  return { 新id: 新.新id, 事件: 新.事件 ?? null, 字节: 新.字节 ?? null, 原会话未改动: true }
}

export async function 执行转移区间(id, 区间表, 跳过活检查 = false, 预设 = '') {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  const 老段 = 整轮片段(体, 区间)
  if (!老段.length) throw new Error('勾选的段里没有可转移的记录')

  const 新 = await 建新会话(s.文件, 老段, '旧记录', path.dirname(path.dirname(s.文件)), 'old', 预设, false)

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
