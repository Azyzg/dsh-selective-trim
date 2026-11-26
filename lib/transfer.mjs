// transfer
import fs from 'node:fs'
import path from 'node:path'
import { 备份, 挡活会话, 标待重启 } from './backup.mjs'
import { 投影根 } from './base.mjs'
import { 重建, 重编轮步 } from './clean.mjs'
import { 写会话, 宿主校验, 校验, 读会话 } from './io.mjs'
import { 过闸, 重置折叠账 } from './ledger.mjs'
import { 找会话 } from './sessions.mjs'
import { 合法预设 } from './presets.mjs'

export async function 执行转移记录(id, 保留轮数 = 20, 跳过活检查 = false, 预设 = '') {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 保留 = Math.max(1, Math.floor(Number(保留轮数) || 20))
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  // 边界按「从末尾数第 N 个 turn/start」定位，切分用 seq：时间乱序时按时间切会切出残轮
  const 界 = 轮头[轮头.length - 保留]
  if (!界 || 界 === 轮头[0]) throw new Error('保留 ' + 保留 + ' 轮就是全部 ' + 轮头.length + ' 轮，没有更早的可转移')
  const 界序 = Number(界.seq)
  const 老段 = 体.filter((e) => Number(e.seq) < 界序)
  if (!老段.length) throw new Error('没挑出可转移的记录')

  // 新会话：id 用 原id-old-<时间>，放在同一个工作区目录下
  const 时分 = new Date()
  const 戳 = String(时分.getMonth() + 1).padStart(2, '0') + String(时分.getDate()).padStart(2, '0') + '-' + String(时分.getHours()).padStart(2, '0') + String(时分.getMinutes()).padStart(2, '0')
  const 基id = path.basename(path.dirname(s.文件)).replace(/^session-/, '')
  let 新id = 基id + '-' + 词 + '-' + 戳
  const 工作区根 = path.dirname(path.dirname(s.文件))
  for (let n = 2; fs.existsSync(path.join(工作区根, 新id)); n += 1) 新id = 基id + '-' + 词 + '-' + 戳 + '-' + n
  const 新目录 = path.join(工作区根, 新id)
  fs.mkdirSync(新目录, { recursive: true })

  const 新头 = { ...JSON.parse(JSON.stringify(头)), id: 新id, createdAt: Date.now() }
  const 原题 = (体.find((e) => e.type === 'session/title') || {}).data
  const 新题 = 原题 && typeof 原题.title === 'string' ? 原题.title + '·旧记录' : 新id
  const 新事件源 = []
  for (const e of 老段) {
    if (!['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'system/message', 'tool/call', 'tool/result'].includes(e.type)) continue
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(份.type)) 份.surfaceOp = 'append'
    新事件源.push(份)
  }
  const 新题事件 = { type: 'session/title', seq: 0, time: Date.now(), data: { title: 新题, messageSeqs: [], source: { kind: 'user' } } }
  const 新全部 = [...新事件源, 新题事件].map((e, i) => ({ ...e, seq: i }))
  重编轮步(新全部)
  const 新临时 = path.join(新目录, 'session.v4.jsonl.zstd.new')
  写会话(新头, 新全部, 新临时)
  const 新查 = await 宿主校验(新临时, 新全部.length)
  if (新查 && 新查.ok === false) {
    fs.rmSync(新临时, { force: true })
    fs.rmSync(新目录, { recursive: true, force: true })
    throw new Error('新会话没通过宿主校验，什么都没动：' + String(新查.message || 新查.错 || ''))
  }
  const 新文件 = path.join(新目录, 'session.v4.jsonl.zstd')
  fs.renameSync(新临时, 新文件)
  try {
    const 新字节 = fs.statSync(新文件).size
    void 新字节
  } catch {}

  // 再从原会话里把这一段删掉
  const { 前置, 其余 } = 重建(体, [], 'drop', [Number(体[0].seq), 界序 - 1])
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临时 = s.文件 + '.moving'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error('原会话删完没通过宿主校验，原文件没动（新会话已建好：' + 新id + '）：' + String(真验.message || ''))
  }
  const 备份到 = 备份(s.文件, 'before-move')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(投影根, 'session-' + s.id + '.json')
  try {
    fs.rmSync(投影, { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '转移记录')
  const 新字节 = fs.statSync(新文件).size
  return {
    ok: true,
    模式: 'move',
    会话: path.basename(path.dirname(s.文件)),
    新会话: 新id,
    新事件: 新全部.length,
    新大小: (新字节 / 1024 / 1024).toFixed(2) + ' MB',
    备份: 备份到,
    总轮,
    保留轮: 保留,
    转移轮: Math.max(0, 总轮 - 保留),
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

// 按时间区间取账里覆盖这些 seq 的压缩记忆块
export async function 建新会话(源文件, 老段, 题尾巴, 工作区根, 词 = 'old', 预设 = '') {
  const 头 = 读会话(源文件).头
  const 时分 = new Date()
  const 戳 =
    String(时分.getMonth() + 1).padStart(2, '0') +
    String(时分.getDate()).padStart(2, '0') +
    '-' +
    String(时分.getHours()).padStart(2, '0') +
    String(时分.getMinutes()).padStart(2, '0')
  const 基id = path.basename(path.dirname(源文件)).replace(/^session-/, '')
  let 新id = 基id + '-' + 词 + '-' + 戳
  for (let n = 2; fs.existsSync(path.join(工作区根, 新id)); n += 1) 新id = 基id + '-' + 词 + '-' + 戳 + '-' + n
  const 新目录 = path.join(工作区根, 新id)
  fs.mkdirSync(新目录, { recursive: true })

  const 新头 = { ...JSON.parse(JSON.stringify(头)), id: 新id, createdAt: Date.now() }
  // 新会话的 agent preset：调用方指定优先，否则沿用源会话
  const 选预设 = (await 合法预设(预设)) || String(头.agentPreset || '')
  if (选预设) 新头.agentPreset = 选预设
  const 原题 = 读会话(源文件).体.find((e) => e.type === 'session/title')
  const 原题字 = 原题 && 原题.data && typeof 原题.data.title === 'string' ? 原题.data.title : 新id
  const 新事件 = []
  for (const e of 老段) {
    if (
      !['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'system/message', 'tool/call', 'tool/result'].includes(
        e.type,
      )
    )
      continue
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(份.type)) 份.surfaceOp = 'append'
    新事件.push(份)
  }
  const 题事件 = {
    type: 'session/title',
    seq: 0,
    time: Date.now(),
    data: { title: 原题字 + '·' + (题尾巴 || '旧记录'), messageSeqs: [], source: { kind: 'user' } },
  }
  const 全部 = [...新事件, 题事件].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临 = path.join(新目录, 'session.v4.jsonl.zstd.new')
  写会话(新头, 全部, 临)
  const 验 = await 宿主校验(临, 全部.length)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    fs.rmSync(新目录, { recursive: true, force: true })
    throw new Error('新会话没通过宿主校验，什么都没动：' + String(验.message || 验.错 || ''))
  }
  const 实 = path.join(新目录, 'session.v4.jsonl.zstd')
  fs.renameSync(临, 实)
  return { 新id, 新文件: 实, 事件: 全部.length, 字节: fs.statSync(实).size }
}

// 转移记录（按勾选的段）：先把这些段搬进新会话，再从原会话删掉
// 复制记录：把选中的这段原样复制成一条新会话，原会话完全不动（不备份、不重置账、不用重启）
export async function 执行复制区间(id, 区间表, 预设 = '') {
  const s = 找会话(id)
  const { 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  const 在里 = (e) => 区间.some(([a, b]) => Number(e.time) >= a && Number(e.time) <= b)
  const 老段 = 体.filter(在里)
  if (!老段.length) throw new Error('勾选的段里没有可复制的记录')
  const 新 = await 建新会话(s.文件, 老段, '副本', path.dirname(path.dirname(s.文件)), 'copy', 预设)
  return { 新id: 新.新id, 事件: 新.事件 ?? null, 字节: 新.字节 ?? null, 原会话未改动: true }
}

export async function 执行转移区间(id, 区间表, 跳过活检查 = false, 预设 = '') {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  const 在里 = (e) => 区间.some(([a, b]) => Number(e.time) >= a && Number(e.time) <= b)
  const 老段 = 体.filter(在里)
  if (!老段.length) throw new Error('勾选的段里没有可转移的记录')

  const 新 = await 建新会话(s.文件, 老段, '旧记录', path.dirname(path.dirname(s.文件)), 'old', 预设)

  const { 前置, 其余 } = 重建(体, 区间, 'drop')
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  const 临 = s.文件 + '.moving'
  写会话(头, 全部, 临)
  const 查 = await 校验(临)
  const 验 = await 宿主校验(临, 查.事件)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    throw new Error('原会话删完没通过宿主校验，原文件没动（新会话已建好：' + 新.新id + '）：' + String(验.message || ''))
  }
  const 备份到 = 备份(s.文件, 'before-move')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临, s.文件)
  try {
    fs.rmSync(path.join(投影根, 'session-' + s.id + '.json'), { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '转移记录')
  return {
    ok: true,
    模式: 'move',
    会话: path.basename(path.dirname(s.文件)),
    新会话: 新.新id,
    新事件: 新.事件,
    新大小: (新.字节 / 1024 / 1024).toFixed(2) + ' MB',
    备份: 备份到,
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

// 折叠记忆（按勾选的段）：删掉这些段，换成账里覆盖它们的压缩记忆
