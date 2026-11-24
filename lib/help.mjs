// help：帮助正文的读写（存在数据根下，改完一直生效）
import fs from 'node:fs'
import path from 'node:path'
import { 数据根 } from './base.mjs'

export const 帮助文件 = path.join(数据根, 'help.md')

export function 读帮助() {
  try {
    return fs.readFileSync(帮助文件, 'utf8')
  } catch {
    return ''
  }
}

export function 写帮助(文本) {
  const s = String(文本 ?? '')
  if (!s.trim()) {
    try {
      fs.rmSync(帮助文件, { force: true })
    } catch {}
    return ''
  }
  fs.mkdirSync(数据根, { recursive: true })
  fs.writeFileSync(帮助文件, s)
  return s
}
