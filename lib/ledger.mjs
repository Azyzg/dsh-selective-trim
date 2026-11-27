// ledger
import fs from 'node:fs'
import path from 'node:path'
import { 备份 } from './backup.mjs'
import { 状态, ACP库, ACP目录, 折叠上限, 账库, 需 } from './base.mjs'

export function 估体tokens(体) {
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
export function 过闸(id, 全体) {
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

export function 打开账库() {
  if (状态.账库 !== undefined) return 状态.账库
  try {
    const 模 = 需('node:sqlite')
    状态.账库 = new 模.DatabaseSync(ACP库, { readOnly: true })
  } catch {
    状态.账库 = null
  }
  return 状态.账库
}

export function 账在用的tokens(id) {
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

export function 账本键(id) {
  const 裸 = String(id).replace(/^session-/, '')
  return [...new Set([裸, `session-${裸}`])]
}

// 一次请求可能落在「主车道」或 `<主id>|sub:<hex>` 子车道，账都记在对应车道上。
// 这里把两种主键和所有子车道键一起列出来。
export function 全部账键(db, id) {
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
export function 有折叠账(id) {
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
export function require_node_sqlite() {
  if (!sqlite模块) sqlite模块 = process.getBuiltinModule('node:sqlite')
  return sqlite模块
}
export function 重置折叠账(id, 备注 = 'clean') {
  const 结果 = { 有账: false, 删块: 0, 备份: [], 键: [] }
  // 账可能挂在 `|sub:<hex>` 子车道上（一次请求走哪条车道就会写哪条），
  // 只按主键删会漏掉整本账 —— 表现就是「清完账没失效」。
  const 键集 = new Set(账本键(id))
  try {
    const { DatabaseSync } = require_node_sqlite()
    const db = new DatabaseSync(ACP库)
    try { for (const k of 全部账键(db, id)) 键集.add(k) } catch {}
    for (const 键 of 键集) {
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
  const 候选 = new Set(键集)
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


// 我们自己写进会话的折叠记忆，格式是每个块一行「（i/N）题」+ 正文。
// ACP 之后再折叠时，会把这些文字当成普通对话总结成新块 —— 于是记忆里套记忆。
// 这里把这种块拆回原始块，保证「已折叠过的内容」不会被再折一次。
export function 展开已折叠(出) {
  const 结果 = []
  for (const 项 of 出) {
    const 文 = String(项.文 || '')
    if (!文.includes('）') || !/（\d+\/\d+）/.test(文)) {
      结果.push(项)
      continue
    }
    const 片 = [...文.matchAll(/（(\d+)\/(\d+)）([^\n]*)\n?([\s\S]*?)(?=（\d+\/\d+）|$)/g)]
    if (!片.length) {
      结果.push(项)
      continue
    }
    for (const m of 片) {
      结果.push({ 序: 结果.length + 1, 题: String(m[3] || '').trim().slice(0, 40), 文: String(m[4] || '').trim() })
    }
  }
  // 去重：同题 + 同开头 60 字
  const 见 = new Set()
  return 结果.filter((x) => {
    const k = String(x.题 || '') + '|' + String(x.文 || '').slice(0, 60)
    if (见.has(k)) return false
    见.add(k)
    return true
  })
}

export async function 取压缩记忆(id) {
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
      if (出.length) return 展开已折叠(出)
    }
    return []
  } finally {
    try {
      句柄.close()
    } catch {}
  }
}

// 折叠记忆替换对话：老轮次整段删掉，换成账里的压缩记忆，接上最近 N 轮原文
export async function 取记忆块(id, 最小seq, 最大seq) {
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
