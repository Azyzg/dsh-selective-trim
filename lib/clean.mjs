// clean
import fs from 'node:fs'
import path from 'node:path'
import { 备份, 挡活会话, 标待重启 } from './backup.mjs'
import { 字时, 家, 表面, 骨架 } from './base.mjs'
import { 折叠注入 } from './inject.mjs'
import { 写会话, 宿主校验, 校验, 读会话 } from './io.mjs'
import { 过闸, 重置折叠账 } from './ledger.mjs'
import { 找会话 } from './sessions.mjs'

// 修结构：保证每个 turn/start 都有配对的 turn/end、每个 step/start 都有 step/end。
// 日志里的 time 会乱序、同一毫秒多条，按时间切窗口很容易切在「一轮中间」，
// 结果就是「turn 123 只有 step/start 和几条消息，没有 turn/end 就开了 turn 124」。
// 这里是最后兜底：缺什么补什么，完全不看时间戳。
function 补步(turn, step, time) {
  return { type: 'step/end', time, data: { turn, step } }
}

function 补轮(turn, time) {
  return { type: 'turn/end', time, data: { turn, reason: { kind: 'completed' } } }
}

export function 修结构(序) {
  const 出 = []
  let 轮 = null // 当前开着的轮号，null 表示没有
  let 步 = null // 当前开着的步号
  const 时 = () => (出.length ? Number(出[出.length - 1].time) || Date.now() : Date.now())
  for (const e of 序) {
    if (e.type === 'turn/start') {
      if (步 !== null) 出.push(补步(轮, 步, 时()))
      if (轮 !== null) 出.push(补轮(轮, 时()))
      步 = null
      轮 = Number(e.data?.turn) || 0
    } else if (e.type === 'step/start') {
      if (步 !== null) 出.push(补步(轮, 步, 时()))
      步 = Number(e.data?.step) || 0
    } else if (e.type === 'step/end') {
      步 = null
    } else if (e.type === 'turn/end') {
      步 = null
      轮 = null
    }
    出.push(e)
  }
  if (步 !== null) 出.push(补步(轮, 步, 时()))
  if (轮 !== null) 出.push(补轮(轮, 时()))
  return 出
}

export function 重建(体, 删键起止, 模式 = 'all', 序窗 = null) {
  // 序窗 可以是 [起seq, 止seq]，也可以是若干段的数组；给了就完全按 seq 切
  const 窗 = Array.isArray(序窗?.[0]) ? 序窗 : 序窗 ? [序窗] : null
  const 在窗口内 = 窗
    ? (e) => 窗.some(([a, b]) => Number(e.seq) >= a && Number(e.seq) <= b)
    : (e) => 删键起止.some(([a, b]) => e.time >= a && e.time <= b)
  // 记录可能不是按 seq 顺序写的（多帧追加、乱序），先按 seq 拍平再切，否则窗口会切得前后颠倒
  体 = [...体].sort((a, b) => Number(a.seq) - Number(b.seq))
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
  // 拍平结构：缺 turn/end、step/end 的补上（时间戳不可信的兜底），再快照提前、统一重编 seq
  const 修好 = 修结构(序)
  序 = 修好
  const 快照类 = new Set([
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'model/selection',
    'session/title',
  ])
  const 最新 = new Map()
  for (const e of 修好) if (快照类.has(e.type)) 最新.set(e.type, e)
  const 前置 = [...最新.values()]
  const 其余 = 修好.filter((e) => !快照类.has(e.type))
  void 首条用户
  return { 前置, 其余 }
}

// ── 重复系统注入：每轮都会被重贴一遍的东西（记忆快照、运行上下文、system-reminder…），只留最新一份 ──
export async function 执行去重(id, 强制 = false) {
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
export async function 执行清除区间(id, 区间表, 模式 = 'all', 强制 = false) {
  await 挡活会话(id, 强制)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (Array.isArray(区间表) ? 区间表 : [])
    .map((r) => [Number(r?.起ms ?? r?.[0]), Number(r?.止ms ?? r?.[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
  if (!区间.length) throw new Error('没有选中任何段')
  // 把「时间区间」换成「seq 区间」，并且往后把半轮补齐到 turn/end：
  // 段落边界落在轮中间时，只按时间切会留下没有 turn/end 的残轮。
  const 序号窗 = 区间
    .map(([a, b]) => {
      const 段 = 体.filter((e) => Number(e.time) >= a && Number(e.time) <= b)
      if (!段.length) return null
      const 起 = Number(段[0].seq)
      let 止 = Number(段[段.length - 1].seq)
      for (const e of 体) {
        const q = Number(e.seq)
        if (q <= 止) continue
        if (e.type === 'step/end' || e.type === 'turn/end') {
          止 = q
          continue
        }
        break
      }
      return [起, 止]
    })
    .filter(Boolean)
  if (!序号窗.length) throw new Error('没有选中任何段')
  const 原字节 = fs.statSync(s.文件).size
  const { 前置, 其余 } = 重建(体, [], 模式, 序号窗)
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
export function 重编轮步(全部) {
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
