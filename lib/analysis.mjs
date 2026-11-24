// analysis
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { 备份根, 字时, 工具类, 窗口token } from './base.mjs'
import { 帧边界, 摘要, 文本, 读会话 } from './io.mjs'
import { 估算缓存路径, 找会话, 概要, 正文字数 } from './sessions.mjs'
import { 时间线 } from './table.mjs'

export function 分段(体, 空档分钟 = 90) {
  const 段 = []
  let 当前 = null
  for (const e of 体) {
    const t = typeof e.time === 'number' ? e.time : 0
    if (!当前 || (t && 当前.到 && t - 当前.到 > 空档分钟 * 60000)) {
      当前 = { 起: t, 到: t, 事件: [], 首句: '', 用户消息: 0, 工具: 0 }
      段.push(当前)
    }
    当前.到 = Math.max(当前.到, t)
    当前.事件.push(e)
    if (e.type === 'user/message') {
      当前.用户消息 += 1
      const 句 = 摘要(文本(e.data))
      // 跳过身份注入、system-reminder、定时提醒这类「不是人说的话」的块，否则首句全是 ［身份］你是…
      if (
        !当前.首句 &&
        句 &&
        !/^([[<［]|人设依据|Current runtime context|MNEMON|Time sampled|Instructions from:|You are |# )/.test(句)
      )
        当前.首句 = 句
    }
    if (e.type === 'tool/call') 当前.工具 += 1
  }
  return 段.filter((s) => s.事件.length > 0)
}

// 只数「会进模型上下文」的正文：文本块字符数（中文约 1 字 ≈ 1 token）。data.stream 不算。
export function 估算(字节) {
  return Math.round(字节 / 3.4)
}

export function 估算字(字数) {
  return Math.round(字数 * 0.85)
}

// 只解前几帧，拿「首句用户消息」当名字用——整份解压太慢
export function 估算tokens(文件) {
  let 键
  let st
  try {
    st = fs.statSync(文件)
    键 = path.basename(path.dirname(文件))
  } catch {
    return 0
  }
  let 缓 = {}
  try {
    缓 = JSON.parse(fs.readFileSync(估算缓存路径(), 'utf8')) || {}
  } catch {}
  const 旧 = 缓[键]
  if (旧 && 旧.m === st.mtimeMs && 旧.s === st.size) return 旧.t
  let 字 = 0
  try {
    const { 体 } = 读会话(文件)
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
  } catch {
    return 0
  }
  const t = Math.round(字 / 1.6)
  缓[键] = { m: st.mtimeMs, s: st.size, t, 字 }
  try {
    fs.mkdirSync(备份根, { recursive: true })
    fs.writeFileSync(估算缓存路径(), JSON.stringify(缓))
  } catch {}
  return t
}

export function 读占用(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = 帧边界(buf)
    for (let k = 帧.length - 1; k >= 0; k--) {
      let 文本段
      try {
        文本段 = zlib.zstdDecompressSync(buf.subarray(帧[k][0], 帧[k][1])).toString('utf8')
      } catch {
        continue
      }
      const 行 = 文本段.split('\n').filter(Boolean)
      for (let j = 行.length - 1; j >= 0; j--) {
        let e
        try {
          e = JSON.parse(行[j])
        } catch {
          continue
        }
        const u = e?.data?.usage
        const 数 = Number(u?.totalTokens)
        if (Number.isFinite(数) && 数 > 0) return { token: 数, 窗口: 窗口token }
      }
    }
  } catch {}
  return { token: 0, 窗口: 窗口token }
}

// 从最后一帧往回找带 turn 的事件，拿到当前最大轮号（不必整份解压）
export function 读轮数(文件) {
  try {
    const buf = fs.readFileSync(文件)
    const 帧 = 帧边界(buf)
    for (let k = 帧.length - 1; k >= 0; k--) {
      let 文本段
      try {
        文本段 = zlib.zstdDecompressSync(buf.subarray(帧[k][0], 帧[k][1])).toString('utf8')
      } catch {
        continue
      }
      const 行 = 文本段.split('\n').filter(Boolean)
      for (let j = 行.length - 1; j >= 0; j--) {
        let e
        try {
          e = JSON.parse(行[j])
        } catch {
          continue
        }
        const 轮 = Number(e?.data?.turn)
        if (Number.isFinite(轮) && 轮 > 0) return 轮
      }
    }
  } catch {}
  return 0
}

export function 分析(id) {
  return 分析文件(找会话(id).文件)
}

// 段太多的时候（一次对话几千轮能切出三四十段），表就没法看了：
// 把相邻的小段并到一块，凑到最多 10 行，保留时间边界
export function 合并段(清单, 上限 = 10) {
  if (清单.length <= 上限) return 清单
  const 每 = Math.ceil(清单.length / 上限)
  const 出 = []
  for (let i = 0; i < 清单.length; i += 每) {
    const 块 = 清单.slice(i, i + 每)
    if (!块.length) continue
    const 首 = 块[0]
    const 尾 = 块[块.length - 1]
    出.push({
      ...首,
      键: String(出.length),
      起: 首.起,
      止: 尾.止,
      起ms: 首.起ms,
      止ms: 尾.止ms,
      事件: 块.reduce((a, x) => a + x.事件, 0),
      轮: 块.reduce((a, x) => a + x.轮, 0),
      用户: 块.reduce((a, x) => a + x.用户, 0),
      工具: 块.reduce((a, x) => a + x.工具, 0),
      工具字: 块.reduce((a, x) => a + x.工具字, 0),
      对话字: 块.reduce((a, x) => a + x.对话字, 0),
      字节: 块.reduce((a, x) => a + x.字节, 0),
      字: 块.reduce((a, x) => a + x.字, 0),
      token: 块.reduce((a, x) => a + x.token, 0),
      占比: Math.round(块.reduce((a, x) => a + x.占比, 0) * 10) / 10,
      子: 块.flatMap((x) => (Array.isArray(x.子) && x.子.length ? x.子 : [[x.起ms, x.止ms]])),
      并了: 块.length,
    })
  }
  return 出
}

export function 分析文件(文件) {
  const { 体 } = 读会话(文件)
  // 宿主正在重写会话文件时，zstd 里可能只有一个表头帧：读出来是空壳。
  // 这时切段必然是 0，别让上层把「切出了 0 段」当正常结果投出去。
  if (!体.length) throw new Error(`会话日志读出来是空的（0 条事件）：${path.basename(path.dirname(文件))}`)
  const 段 = 分段(体)
  const 总字节 = Buffer.byteLength(JSON.stringify(体))
  const 总字 = 体.reduce((a, e) => a + 正文字数(e), 0)
  const 工具字 = 体.reduce((a, e) => a + (工具类.has(e.type) ? 正文字数(e) : 0), 0)
  const 占用 = 读占用(文件)
  const 实测 = 占用.token || 0
  const 清单 = 段.map((s2, i) => {
    const 字节 = Buffer.byteLength(JSON.stringify(s2.事件))
    const 字 = s2.事件.reduce((a, e) => a + 正文字数(e), 0)
    const 本段工具字 = s2.事件.reduce((a, e) => a + (工具类.has(e.type) ? 正文字数(e) : 0), 0)
    const 名字 = [...new Set(s2.事件.filter((e) => e.type === 'tool/call').map((e) => String(e.data?.name || '')))].filter(Boolean)
    // 体积按「实测占用 × 本段在全文里的字节占比」算，这样各段加起来正好等于真实占用
    const 占比 = 总字节 ? 字节 / 总字节 : 0
    return {
      键: String(i),
      标题: s2.首句 || '(无正文)',
      起: 字时(s2.起),
      止: 字时(s2.到),
      起ms: s2.起,
      止ms: s2.到,
      事件: s2.事件.length,
      轮: s2.事件.filter((e) => e.type === 'turn/start').length,
      用户: s2.用户消息,
      工具: s2.工具,
      工具字: 本段工具字,
      对话字: Math.max(0, 字 - 本段工具字),
      内容: 名字.slice(0, 4).join('、'),
      字节,
      字,
      token: 实测 ? Math.round(实测 * 占比) : 估算字(字),
      占比: Math.round(占比 * 1000) / 10,
      子: [[s2.起, s2.到]],
    }
  })
  return {
    会话: 概要(文件),
    总字节,
    总token: 实测 || 估算字(总字),
    总工具字: 工具字,
    占用: 实测,
    窗口: 占用.窗口,
    占用率: 实测 ? Math.round((实测 / (占用.窗口 || 窗口token)) * 100) : 0,
    段: 合并段(清单),
    原始段数: 清单.length,
    时间线: 时间线(体, 实测),
  }
}

// 清完还剩多少 token（按正文字数估，中文约 1.6 字/token）
