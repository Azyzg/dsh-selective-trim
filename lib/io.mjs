// io
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Worker } from 'node:worker_threads'
import { zstd魔, 校验器, 每帧行数 } from './base.mjs'

export function 读会话(文件) {
  const 读一遍 = () => {
    const 原 = fs.readFileSync(文件)
    const 文 = 读全文(原)
    const 行 = 文.split('\n').filter(Boolean)
    return { 原, 文, 行 }
  }
  let 次 = 读一遍()
  // 只解出表头一行 = 文件此刻只有表头帧（宿主正在重写），稍等再读一次
  for (let i = 0; i < 3 && 次.行.length <= 1; i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    次 = 读一遍()
  }
  if (次.行.length <= 1) {
    throw new Error(
      `会话日志里只有表头、没有事件（文件 ${次.原.length} 字节，解压后 ${次.文.length} 字节）：${path.basename(path.dirname(文件))}`,
    )
  }
  return { 头: JSON.parse(次.行[0]), 体: 次.行.slice(1).map((l) => JSON.parse(l)) }
}

export function 文本(message) {
  if (!message || typeof message !== 'object') return ''
  const 块 = Array.isArray(message.content) ? message.content : []
  return 块.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

export function 摘要(text) {
  const 干 = String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\[系统提醒\][\s\S]*/, '')
    .replace(/<dsh_im_source>[\s\S]*?<\/dsh_im_source>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return 干.length > 34 ? 干.slice(0, 34) + '…' : 干
}

export function 帧尾(buf, 起) {
  let i = 起 + 4
  if (i >= buf.length) return buf.length
  const fhd = buf[i]
  i += 1
  const fcs标 = fhd >> 6
  const 单段 = (fhd & 0x20) !== 0
  const 校验 = (fhd & 0x04) !== 0
  const 字典标 = fhd & 0x03
  if (!单段) i += 1 // window descriptor
  i += 字典标 === 3 ? 4 : 字典标
  i += fcs标 === 0 ? (单段 ? 1 : 0) : fcs标 === 1 ? 2 : fcs标 === 2 ? 4 : 8
  while (i + 3 <= buf.length) {
    const h = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)
    i += 3
    const 末块 = h & 1
    const 型 = (h >> 1) & 3
    const 长 = h >>> 3
    if (型 === 0) i += 长
    else if (型 === 1) i += 1
    else if (型 === 2) i += 长
    else return buf.length // 保留块类型，坏了
    if (末块) break
  }
  if (校验) i += 4
  return Math.min(i, buf.length)
}

export function 帧边界(buf) {
  const 出 = []
  let i = 0
  while (i + 4 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0xfd2fb528) {
      const 下 = buf.indexOf(zstd魔, i + 1)
      if (下 < 0) break
      i = 下
      continue
    }
    const 尾 = 帧尾(buf, i)
    if (尾 <= i + 4) break
    出.push([i, 尾])
    i = 尾
  }
  return 出
}

// 多帧拼接的文件：整块 zstdDecompressSync 只会解第一帧，得逐帧解再拼起来
export function 读全文(buf) {
  const 帧 = 帧边界(buf)
  if (帧.length > 1) {
    const 段 = 帧.map(([a, b]) => {
      try {
        return zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8')
      } catch {
        return ''
      }
    })
    const 合 = 段.join('')
    if (合.split('\n').filter(Boolean).length > 1) return 合
  }
  return zlib.zstdDecompressSync(buf).toString('utf8')
}

// 从最后一帧往回找带 usage 的 assistant/message
// 日志里最后一条 usage 是「当时」的占用，之后又追加了很多内容就不会更新了。
// 所以另算一个按正文字数的估算（中文约 1.6 字/token），两者取大，避免面板把爆掉的会话显示成 12%。
export function 写会话(头, 事件, 出口) {
  // 宿主要求：第一帧只有 header 一行，之后每帧若干事件
  const 缓冲 = [
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(头) + '\n', 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }),
  ]
  for (let i = 0; i < 事件.length; i += 每帧行数) {
    const 块 = 事件.slice(i, i + 每帧行数).map((e) => JSON.stringify(e)).join('\n') + '\n'
    缓冲.push(
      zlib.zstdCompressSync(Buffer.from(块, 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    )
  }
  fs.writeFileSync(出口, Buffer.concat(缓冲))
}

// 用宿主自己的持久化校验器（离线跑，不用重启）验一份文件
export function 宿主校验(文件, 期数) {
  return new Promise((好) => {
    if (!fs.existsSync(校验器)) return 好({ ok: true, message: '（没装离线校验器，跳过）' })
    let 结束 = false
    const 收 = (r) => {
      if (结束) return
      结束 = true
      try {
        工.terminate()
      } catch {}
      好(r)
    }
    // 校验器要 path + compression + expectedId + expectedEventCount 四件；少 expectedId 会直接报
    // 「migration verifier request is malformed」。id 从首帧的 header 里取。
    let 期id = ''
    try {
      期id = String(读会话(文件).头?.id || '')
    } catch {}
    期数 = Number(期数) || 事件数
    let 工
    try {
      工 = new Worker(校验器, {
        workerData: { path: 文件, compression: 'zstd', expectedId: 期id, expectedEventCount: 期数 },
      })
    } catch (e) {
      return 好({ ok: false, message: '校验器起不来：' + String(e?.message || e) })
    }
    工.on('message', (m) => 收(m && typeof m === 'object' ? m : { ok: false, message: String(m) }))
    工.on('error', (e) => 收({ ok: false, message: '校验器崩了：' + String(e?.message || e) }))
    工.on('exit', () => 收({ ok: false, message: '校验器没给结论' }))
    setTimeout(() => 收({ ok: false, message: '校验器超时' }), 20000)
  })
}

export async function 校验(文件) {
  const { 头, 体 } = 读会话(文件)
  const 问题 = []
  const 事件 = 体.map((e) => e.type)
  // 轮/步配对
  let 开轮 = 0
  for (const e of 体) {
    if (e.type === 'turn/start') 开轮 += 1
    if (e.type === 'turn/end') 开轮 -= 1
    if (开轮 < 0) 问题.push('turn/end 多于 turn/start')
  }
  for (let i = 0; i < 体.length; i += 1) if (体[i].seq !== i) { 问题.push(`seq 不连续于 ${i}`); break }
  const 有调用 = new Set(体.filter((e) => e.type === 'tool/call').map((e) => e.data?.callId))
  for (const e of 体) {
    if (e.type === 'tool/result') {
      const id2 = e.data?.toolCallId ?? e.data?.message?.toolCallId
      if (!有调用.has(id2)) 问题.push(`孤儿 tool/result ${e.seq}`)
    }
    if (Array.isArray(e.sourceEventSeqs)) {
      for (const s of e.sourceEventSeqs) if (!(s < e.seq)) 问题.push(`${e.type} 的 sourceEventSeqs 指向不更早的 ${s}`)
    }
    if (e.surfaceOp && typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') 问题.push(`残留 replace ${e.seq}`)
  }
  return { 头, 问题: [...new Set(问题)].slice(0, 8), 事件: 体.length }
}
