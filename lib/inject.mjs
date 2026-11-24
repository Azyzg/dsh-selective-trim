// inject
import { 注入头表 } from './base.mjs'

export let 保留份数 = 5
export function 设保留份数(n) {
  const v = Number(n)
  if (Number.isFinite(v) && v >= 1 && v <= 50) 保留份数 = Math.floor(v)
  return 保留份数
}

// 骨架事件：清掉内容时仍要留下，宿主靠它们配对 turn/step
export function 消息包(e) {
  if (e.type !== 'user/message' && e.type !== 'system/message') return null
  const 消息 = e.data?.message ?? e.data
  const 块 = Array.isArray(消息?.content) ? 消息.content : null
  return 块 ? { 块 } : null
}

// 一段文本里哪些区段属于系统注入
export function 注入区(text) {
  const 区 = []
  const re = /<system-reminder>[\s\S]*?<\/system-reminder>/g
  let m
  while ((m = re.exec(text))) 区.push({ 起: m.index, 止: m.index + m[0].length, 类: 'system-reminder' })
  if (区.length === 0) {
    for (const t of 注入头表) {
      if (t.头.test(text)) return [{ 起: 0, 止: text.length, 类: t.类 }]
    }
  }
  return 区
}

export function 扫注入(体) {
  const 全 = []
  for (let i = 0; i < 体.length; i++) {
    const 包 = 消息包(体[i])
    if (!包) continue
    包.块.forEach((b, bi) => {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return
      for (const 区 of 注入区(b.text)) 全.push({ 事件: i, 块: bi, 起: 区.起, 止: 区.止, 类: 区.类, 字: 区.止 - 区.起 })
    })
  }
  return 全
}

export function 统计注入(体) {
  const 全 = 扫注入(体)
  const 组 = new Map()
  for (const x of 全) {
    if (!组.has(x.类)) 组.set(x.类, [])
    组.get(x.类).push(x)
  }
  const 清单 = []
  let 可省 = 0
  for (const [类, 列] of 组) {
    列.sort((a, b) => a.事件 - b.事件 || a.块 - b.块 || a.起 - b.起)
    const 旧 = 列.slice(0, Math.max(0, 列.length - 保留份数))
    const 省 = 旧.reduce((a, x) => a + x.字, 0)
    可省 += 省
    清单.push({ 类, 处数: 列.length, 重复: 旧.length, 字: 列.reduce((a, x) => a + x.字, 0), 可省字: 省 })
  }
  清单.sort((a, b) => b.可省字 - a.可省字)
  return { 总处: 全.length, 保留份数, 可省字: 可省, 清单 }
}

// 把「同类注入」里除最后 N 条以外的全换成一行占位
export function 折叠注入(体) {
  const 全 = 扫注入(体)
  const 组 = new Map()
  for (const x of 全) {
    if (!组.has(x.类)) 组.set(x.类, [])
    组.get(x.类).push(x)
  }
  const 目标 = []
  for (const 列 of 组.values()) {
    列.sort((a, b) => a.事件 - b.事件 || a.块 - b.块 || a.起 - b.起)
    目标.push(...列.slice(0, Math.max(0, 列.length - 保留份数)))
  }
  if (目标.length === 0) return { 体, 折叠: 0, 省字: 0 }
  const 按事件 = new Map()
  for (const x of 目标) {
    if (!按事件.has(x.事件)) 按事件.set(x.事件, [])
    按事件.get(x.事件).push(x)
  }
  let 省字 = 0
  for (const [ei, 列] of 按事件) {
    const e = structuredClone(体[ei])
    const 包 = 消息包(e)
    for (const x of 列.sort((a, b) => b.块 - a.块 || b.起 - a.起)) {
      const b = 包.块[x.块]
      if (!b || typeof b.text !== 'string') continue
      const 原 = b.text
      const 替换 = `（旧的${x.类}已省略，最新一份保留在后文）`
      const 新 = x.止 - x.起 >= 原.length - 1 ? 替换 : 原.slice(0, x.起) + 替换 + 原.slice(x.止)
      if (新.length >= 原.length) continue
      省字 += 原.length - 新.length
      b.text = 新
    }
    体[ei] = e
  }
  return { 体, 折叠: 目标.length, 省字 }
}
