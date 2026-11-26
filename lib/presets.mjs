// presets: 从 profile 补丁里读出可选的 agent preset
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const 补丁路径 =
  process.env.SELECTIVE_TRIM_PROFILE_PATCH || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

export function 预设清单() {
  let 文 = ''
  try {
    文 = fs.readFileSync(补丁路径, 'utf8')
  } catch {
    return ['standard']
  }
  const 名 = new Set()
  for (const 行 of 文.split('\n')) {
    const m = 行.match(/^\s*-\s*id:\s*preset-([\w.-]+)\s*$/)
    if (m) 名.add(m[1])
  }
  if (!名.size) 名.add('standard')
  // standard 排最前，其余按字母序
  const 列 = [...名].sort((a, b) => (a === 'standard' ? -1 : b === 'standard' ? 1 : a.localeCompare(b)))
  return 列
}

export function 合法预设(名) {
  const 列 = 预设清单()
  const 值 = String(名 || '').trim()
  return 列.includes(值) ? 值 : ''
}
