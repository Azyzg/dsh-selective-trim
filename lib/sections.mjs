import fs from 'node:fs'
import path from 'node:path'
import { 数据根 } from './base.mjs'

// 「按内容分节」：让会话自己读一遍块标题、划分段落，插件照它的划分切。
// 文件放在 数据根/分节/<会话目录名>.md，一行一段：`起-止 | 段名`
export const 分节目录 = path.join(数据根, '分节')

export function 分节文件(id) {
  const 名 = String(id || '').replace(/^session-/, '')
  return path.join(分节目录, 名 + '.md')
}

export function 写分节模板(记忆, 会话名, 文件) {
  fs.mkdirSync(path.dirname(文件), { recursive: true })
  const 行 = []
  行.push('# 记忆分节')
  行.push('')
  行.push('会话：' + (会话名 || '') + '；共 ' + 记忆.length + ' 块。')
  行.push('')
  行.push('下面每块一行，格式是 `序号 | 标题 | 字数`。')
  行.push('')
  行.push('## 块清单')
  行.push('')
  记忆.forEach((m, i) => {
    行.push((i + 1) + ' | ' + (m.题 || '（无题）') + ' | ' + String(m.文 || '').length)
  })
  行.push('')
  行.push('## 你的划分')
  行.push('')
  行.push('在下面写你的分节，一行一段，格式：`起-止 | 段名`（序号用上面 1..' + 记忆.length + '）')
  行.push('要求：按工作内容合并，覆盖 1 到 ' + 记忆.length + '、不重叠不留空；段名 6–20 字；')
  行.push('每段 8–15 块为宜，内容明显换题就换段。')
  行.push('')
  fs.writeFileSync(文件, 行.join('\n'), 'utf8')
  return 文件
}

// 解析 `起-止 | 段名`，校验覆盖完整、不重叠
export function 解析分节文(文本, 总块) {
  const 段 = []
  for (const 原 of String(文本 || '').split('\n')) {
    const 行 = 原.trim()
    if (!行 || 行.startsWith('#') || 行.startsWith('会话：') || /^（|^每段/.test(行)) continue
    const m = 行.match(/^(\d+)\s*[-~—到]\s*(\d+)\s*[|｜]?\s*(.*)$/)
    if (!m) continue
    const 起 = Number(m[1])
    const 止 = Number(m[2])
    if (!(起 >= 1 && 止 >= 起 && 止 <= 总块)) continue
    段.push({ 起, 止, 名: (m[3] || '').trim() || ('第 ' + 起 + '–' + 止 + ' 段') })
  }
  if (!段.length) return null
  段.sort((a, b) => a.起 - b.起)
  let 期望 = 1
  for (const s of 段) {
    if (s.起 !== 期望) return null
    期望 = s.止 + 1
  }
  if (期望 !== 总块 + 1) return null
  return 段
}

export function 读分节(文件, 总块) {
  try {
    if (!fs.existsSync(文件)) return null
    return 解析分节文(fs.readFileSync(文件, 'utf8'), 总块)
  } catch {
    return null
  }
}
