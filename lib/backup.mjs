// backup
import fs from 'node:fs'
import path from 'node:path'
import { 状态, 备份保留, 备份根, 家, 待重启文件, 本次进程起, 记 } from './base.mjs'
import { 宿主校验 } from './io.mjs'
import { 重置折叠账 } from './ledger.mjs'
import { 找会话 } from './sessions.mjs'

export function 读待重启() {
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
export function 标待重启(id, 动作) {
  const 全 = 读待重启()
  const 键 = String(id).replace(/^session-/, '')
  全[键] = { 动作, 时间: Date.now(), 进程起: 本次进程起 }
  fs.mkdirSync(备份根, { recursive: true })
  fs.writeFileSync(待重启文件, JSON.stringify(全, null, 2))
}

export function 修剪备份(文件) {
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

export function 备份(文件, 备注) {
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

export function 列备份() {
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
export async function 正在用(id) {
  if (!状态.会话API) return ''
  const 真id = String(id).startsWith('session-') ? String(id) : `session-${String(id)}`
  try {
    if (typeof 状态.会话API.get === 'function') {
      const 一条 = await 状态.会话API.get(真id)
      if (一条) return 真id
    }
    if (typeof 状态.会话API.list === 'function') {
      const 表 = await 状态.会话API.list()
      const 全 = Array.isArray(表) ? 表 : []
      if (全.some((x) => String(x?.id ?? x?.header?.id ?? '') === 真id)) return 真id
    }
  } catch (e) {
    记(`挡活会话查不到（${String(e?.message || e)}），放行`)
  }
  return ''
}

export async function 挡活会话(id, 强制 = false) {
  if (!状态.会话API) {
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

export function 同会话备份(id, 排除名) {
  const 前缀 = `session-${String(id).replace(/^session-/, '')}.session.v4.jsonl.zstd.`
  return fs
    .readdirSync(备份根)
    .filter((n) => n.startsWith(前缀) && n !== 排除名)
    .map((n) => ({ n, t: fs.statSync(path.join(备份根, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map(({ n }) => path.join(备份根, n))
}

export async function 还原(名, 强制 = false) {
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
