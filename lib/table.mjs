// table
import fs from 'node:fs'
import path from 'node:path'
import { 估算字, 分析, 分析文件 } from './analysis.mjs'
import { 备份根, 字时, 本次进程起, 表视图文件 } from './base.mjs'
import { 列会话, 正文字数 } from './sessions.mjs'

export function 表文件(文件) {
  const id = path.basename(path.dirname(文件))
  return path.join(备份根, '构成表', `${id}.md`)
}

export function 写表模板(会话名, 目标) {
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
export function 时间线(体, 实测token, 粒度 = 'auto') {
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
export function 解析区间(文, 年) {
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
  const [a, b0] = [首.ms, 尾.ms].sort((x, y) => x - y)
  // 只写了一个时间点（起止相同）时补一分钟：否则这行会被当成「没有区间」整行跳过，
  // 表里就少一行、总计对不上时间线。
  if (b0 <= a) return [a, a + 60000]
  return [a, b0]
}

// 让会话把行和建议填进插件事先放好的那张表里，面板读回来直接给用户勾
export function 构提问(线, 会话名, 表路径, 总token) {
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
export function 展开覆盖(格, 段表) {
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
export function 解析表文件(路径, 段表, 年) {
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
    // 优先用会话自己写的「大约占用」那一列：它有插件给出的时间线在手，比按粗段表
    // 的重叠比例反推准得多（段表最多 10 段，反推会把一行 62K 算成 3K）。
    const 报K = /([\d.]+)\s*[Kk]/.exec(String(格[2] || ''))
    if (报K && Number(报K[1]) > 0) token = Math.round(Number(报K[1]) * 1000)
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

export function 读表视图() {
  try {
    const s = fs.readFileSync(表视图文件, 'utf8')
    const v = JSON.parse(s)
    if (!v || typeof v !== 'object') return null
    // 没有「当前会话」的表是废的：面板会带着空 sid 发请求，一律当没有，让 恢复表视图 重建
    if (!v.当前) return null
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
export function 恢复表视图() {
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
      const 视图 = { 当前: 会.id, 会话名: 会.标题 || 会.id, 表: 解析.表, 建议: 解析.建议 || '', 原文: '', 时: t }
      try { 写表视图(视图) } catch {}
      return 视图
    }
  }
  return null
}

export function 写表视图(v) {
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
