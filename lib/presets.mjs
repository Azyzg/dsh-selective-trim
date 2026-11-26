// presets: 优先问宿主的 agentPresets 服务，拿不到再退回解析 profile 补丁
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { 状态 } from './base.mjs'

const 补丁路径 =
  process.env.SELECTIVE_TRIM_PROFILE_PATCH || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

// 兜底：从 profile 补丁里的 preset-* 条目读
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
  return [...名].sort((a, b) => (a === 'standard' ? -1 : b === 'standard' ? 1 : a.localeCompare(b)))
}

// 宿主里已声明的预设（含插件注册的 scoped 预设）
export async function 取预设() {
  const 服务 = 状态.宿主ctx && typeof 状态.宿主ctx.get === 'function' ? 状态.宿主ctx.get('agentPresets') : undefined
  if (服务 && typeof 服务.remoteExportList === 'function') {
    try {
      const 出 = await 服务.remoteExportList()
      const 列 = (出 && Array.isArray(出.presets) ? 出.presets : [])
        .filter((r) => r && r.id && !r.broken)
        .map((r) => ({ id: String(r.id), 名: r.name ? String(r.name) : '', 默认: !!r.isDefault }))
      if (列.length) {
        // 默认预设排最前
        return 列.sort((a, b) => (a.默认 === b.默认 ? a.id.localeCompare(b.id) : a.默认 ? -1 : 1))
      }
    } catch {}
  }
  return 预设清单().map((id) => ({ id, 名: '', 默认: id === 'standard' }))
}

export async function 合法预设(名) {
  const 值 = String(名 || '').trim()
  if (!值) return ''
  const 列 = await 取预设()
  if (列.some((p) => p.id === 值)) return 值
  // 宿主没有 agentPresets 服务时（离线调试），列表只是从 profile 补丁猜的，不能据此否决
  const 服务 = 状态.宿主ctx && typeof 状态.宿主ctx.get === 'function' ? 状态.宿主ctx.get('agentPresets') : undefined
  const 权威 = !!(服务 && typeof 服务.remoteExportList === 'function')
  return 权威 ? '' : 值
}
