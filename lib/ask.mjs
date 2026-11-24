// ask
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { 会话控, 宿主ctx, 提问模板 } from './base.mjs'
import { 文本, 读会话 } from './io.mjs'

export function 造用户消息(内容, rpcId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(内容) }],
    source: { kind: 'user', rpcId, clientTimeZone: 'Etc/GMT-8' },
  }
}

// 读活会话里的事件（优先用宿主的会话对象，退回去读文件）
export function 活事件(agent, 文件) {
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
export function 深找(值, 判, 出 = [], 深 = 0) {
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
export async function 宿主投问(文件, 题, req) {
  const 真id = path.basename(path.dirname(文件))
  // 服务可能在宿主启动晚些才注册，所以每次都重新找一遍（找不到才退回 HTTP 那条路）
  for (const 名 of ['sessionController', 'sessionControllerService', 'sessionControl']) {
    if (状态.会话控 && typeof 状态.会话控.resolveAgent === 'function') break
    try {
      const 候 = 状态.宿主ctx?.get?.(名)
      if (候 && typeof 候.resolveAgent === 'function') 状态.会话控 = 候
    } catch {}
  }
  const 头 = req?.headers || {}
  const host = String(头.host || '')
  const cookie = String(头.cookie || '')
  const rpcId = randomUUID()
  const 内容 = String(题 || 提问模板)
  if ((!状态.会话控 || typeof 状态.会话控.resolveAgent !== 'function') && host && cookie) {
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
  if (!状态.会话控 || typeof 状态.会话控.resolveAgent !== 'function') return null
  const 解 = await 状态.会话控.resolveAgent(真id)
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
