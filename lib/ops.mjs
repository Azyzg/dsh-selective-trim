// ops
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { 备份, 挡活会话, 标待重启 } from './backup.mjs'
import { 家, 投影根 } from './base.mjs'
import { 重建, 重编轮步, 修结构 } from './clean.mjs'
import { 写会话, 宿主校验, 校验, 读会话 } from './io.mjs'
import { 取压缩记忆, 过闸, 重置折叠账 } from './ledger.mjs'
import { 找会话 } from './sessions.mjs'

export async function 执行记忆替换(id, 保留轮数 = 20, 记忆源 = '', 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 记忆 = await 取压缩记忆(记忆源 || id)
  if (!记忆.length) {
    throw new Error('这条会话没有可用的折叠记忆（没有压缩账，或账被重置过）。先用「工具结果」或「整轮删除」清一部分。')
  }
  const 保留 = Math.max(1, Math.floor(Number(保留轮数) || 20))
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  const 起点轮 = Math.max(1, 总轮 - 保留 + 1)
  const 界 = 轮头.find((e) => Number(e.data.turn) >= 起点轮)
  if (!界 || 界 === 轮头[0]) throw new Error('保留 ' + 保留 + ' 轮就是全部 ' + 总轮 + ' 轮，没有更早的可替换')

  const 源系统 = 体.find((e) => e.type === 'system/message')
  const 基时 = Number(体[0].time) || Date.now()
  const 记忆消息 = 记忆.map((m, i) => ({
    type: 'user/message',
    seq: 0,
    time: 基时 + i,
    data: {
      role: 'user',
      id: randomUUID(),
      content: [
        {
          type: 'text',
          text: '【压缩记忆 ' + (i + 1) + '/' + 记忆.length + '｜' + (m.题 || '第 ' + m.序 + ' 块') + '】\n' + m.文,
        },
      ],
      source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Etc/GMT-8' },
    },
    surfaceOp: 'append',
  }))
  const 起 = { type: 'turn/start', seq: 0, time: 基时, data: { turn: 1 } }
  const 步起 = { type: 'step/start', seq: 0, time: 基时, data: { turn: 1, step: 1 } }
  const 系统 = 源系统
    ? { ...JSON.parse(JSON.stringify(源系统)), seq: 0, data: { ...JSON.parse(JSON.stringify(源系统.data)), turn: 1, step: 1 } }
    : null
  if (系统) delete 系统.sourceEventSeqs
  const 步终 = { type: 'step/end', seq: 0, time: 基时 + 记忆.length + 1, data: { turn: 1, step: 1 } }
  const 轮终 = { type: 'turn/end', seq: 0, time: 基时 + 记忆.length + 2, data: { turn: 1, reason: { kind: 'completed' } } }

  // 保留下来的老轮次也要过一次结构修补：万一最后一条 turn/end 落在边界外，补上，别留残轮
  const 保 = 修结构(体.filter(
    (e) => e.type !== 'session/title' && Number.isFinite(Number(e.data?.turn)) && Number(e.data.turn) >= 起点轮,
  ))
  for (const e of 保) {
    delete e.sourceEventSeqs
    if (['user/message', 'assistant/message', 'tool/result'].includes(e.type)) e.surfaceOp = 'append'
  }
  const 全部 = [...[起, 步起, ...(系统 ? [系统] : [])], ...记忆消息, 步终, 轮终, ...保].map((e, i) => ({ ...e, seq: i }))
  重编轮步(全部)
  过闸(id, 全部)

  const 临时 = s.文件 + '.memory'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error('宿主校验没过，没有写盘：' + String((真验 && (真验.message || 真验.错)) || 查.错 || '未知原因'))
  }
  const 备份到 = 备份(s.文件, 'before-memory')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(投影根, 'session-' + s.id + '.json')
  try {
    fs.rmSync(投影, { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '折叠记忆替换')
  const 字节 = fs.statSync(s.文件).size
  return {
    ok: true,
    模式: 'memory',
    会话: path.basename(path.dirname(s.文件)),
    备份: 备份到,
    记忆块: 记忆.length,
    总轮,
    保留轮: 保留,
    替换轮: Math.max(0, 总轮 - 保留),
    事件: 全部.length,
    字节,
    大小: (字节 / 1024 / 1024).toFixed(2) + ' MB',
  }
}

// 转移记录：把要删掉的老轮次先落成一条新会话，再从原会话里整段删掉
export async function 执行记忆区间(id, 区间表, 记忆源 = '', 跳过活检查 = false) {
  await 挡活会话(id, 跳过活检查)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 区间 = (区间表 || []).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)])
  if (!区间.length) throw new Error('没有勾选任何段')
  // 账里块的 seq 是 ACP 自己的编号，跟会话事件 seq 不在一个空间，没法逐段对应。
  // 所以这里的语义是：把「从最早一直到你勾的最后一行为止」整段换成账里的压缩记忆，勾选之后的内容原样保留。
  // 勾选段的「止」是时间，换成 seq 再切；时间会乱序，直接按时间切会把轮切开
  const 界 = Math.max(...区间.map(([, b]) => Number(b)))
  const 界序 = 体.filter((e) => Number(e.time) <= 界).reduce((m, e) => Math.max(m, Number(e.seq)), -1)
  if (界序 < 0) throw new Error('勾选的段前面没有可替换的记录')
  const 命中 = 体.filter((e) => Number(e.seq) <= 界序)
  if (!命中.length) throw new Error('勾选的段前面没有可替换的记录')
  const 记忆 = await 取压缩记忆(记忆源 || id)
  if (!记忆.length) {
    throw new Error('这个会话在压缩插件里没有记忆块（可能是新会话、或账已被重置）。想留住它们就用「转移记录」。')
  }

  const { 前置, 其余 } = 重建(体, [], 'drop', [Number(体[0].seq), 界序])
  const 基时 = Number(前置[0] && 前置[0].time) || Date.now()
  const 源系统 = 体.find((e) => e.type === 'system/message')
  const 记忆消息 = 记忆.map((m, i) => ({
    type: 'user/message',
    seq: 0,
    time: 基时 + i,
    data: {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: '【压缩记忆 ' + (i + 1) + '/' + 记忆.length + '｜' + (m.题 || '第 ' + m.序 + ' 块') + '】\n' + m.文 }],
      source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Etc/GMT-8' },
    },
    surfaceOp: 'append',
  }))
  const 起 = { type: 'turn/start', seq: 0, time: 基时, data: { turn: 1 } }
  const 步起 = { type: 'step/start', seq: 0, time: 基时, data: { turn: 1, step: 1 } }
  const 系统 = 源系统 ? { ...JSON.parse(JSON.stringify(源系统)), seq: 0, data: { ...JSON.parse(JSON.stringify(源系统.data)), turn: 1, step: 1 } } : null
  if (系统) delete 系统.sourceEventSeqs
  const 步终 = { type: 'step/end', seq: 0, time: 基时 + 记忆.length + 1, data: { turn: 1, step: 1 } }
  const 轮终 = { type: 'turn/end', seq: 0, time: 基时 + 记忆.length + 2, data: { turn: 1, reason: { kind: 'completed' } } }

  const 全部 = [...[起, 步起, ...(系统 ? [系统] : [])], ...记忆消息, 步终, 轮终, ...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  for (const e of 全部) delete e.sourceEventSeqs
  重编轮步(全部)
  过闸(id, 全部)

  const 临 = s.文件 + '.memory'
  写会话(头, 全部, 临)
  const 查 = await 校验(临)
  const 验 = await 宿主校验(临, 查.事件)
  if (验 && 验.ok === false) {
    fs.rmSync(临, { force: true })
    throw new Error('宿主校验没过，没有写盘：' + String(验.message || 验.错 || 查.错 || ''))
  }
  const 备份到 = 备份(s.文件, 'before-memory')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临, s.文件)
  try {
    fs.rmSync(path.join(投影根, 'session-' + s.id + '.json'), { force: true })
  } catch {}
  await 重置折叠账(id)
  标待重启(id, '折叠记忆')
  return {
    ok: true,
    模式: 'memory',
    会话: path.basename(path.dirname(s.文件)),
    记忆块: 记忆.length,
    备份: 备份到,
    剩余事件: 全部.length,
    剩余字节: fs.statSync(s.文件).size,
  }
}

export async function 执行清旧轮(id, 保留轮数 = 10, 模式 = 'tools', 强制 = false) {
  await 挡活会话(id, 强制)
  const s = 找会话(id)
  const { 头, 体 } = 读会话(s.文件)
  const 保留 = Math.max(0, Math.floor(Number(保留轮数) || 0))
  const 略 = 模式 === 'drop' ? 'drop' : 'tools'
  const 轮头 = 体.filter((e) => e.type === 'turn/start' && Number.isFinite(Number(e.data?.turn)))
  const 总轮 = 轮头.length ? Math.max(...轮头.map((e) => Number(e.data.turn))) : 0
  if (!总轮) throw new Error('这个会话里没有可识别的轮次')
  // 按「从末尾数第 N 个 turn/start」定位边界：轮号可能跳号，按编号找会切在半轮中间。
  // 切割一律用 seq 区间，不用时间——time 会乱序、同毫秒多条，按时间切必然出现残轮。
  const 界 = 轮头[轮头.length - 保留]
  if (!界 || 界 === 轮头[0]) throw new Error(`保留 ${保留} 轮就是全部 ${轮头.length} 轮，没有更早的可清`)
  const { 前置, 其余 } = 重建(体, [], 略, [Number(体[0].seq), Number(界.seq) - 1])
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  if (略 === 'drop') 重编轮步(全部)
  const 临时 = s.文件 + '.cleaning'
  写会话(头, 全部, 临时)
  const 查 = await 校验(临时)
  const 真验 = await 宿主校验(临时, 查.事件)
  if (真验 && 真验.ok === false) {
    fs.rmSync(临时, { force: true })
    throw new Error(`宿主校验没过：${真验.message || '未知'}`)
  }
  const 原字节 = fs.statSync(s.文件).size
  const 备份名 = 备份(s.文件, 'before-clean-old')
  fs.rmSync(s.文件, { force: true })
  fs.renameSync(临时, s.文件)
  const 投影 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (fs.existsSync(投影)) fs.rmSync(投影, { force: true })
  标待重启(s.id, '清旧轮次')
  try { 重置折叠账(s.id, 'clean-old') } catch {}
  return {
    备份: 备份名,
    剩余事件: 查.事件,
    总轮,
    保留轮: 保留,
    清了轮: 总轮 - 保留,
    模式: 略,
    原字节,
    新字节: fs.statSync(s.文件).size,
  }
}

// 同一个会话的其它备份（不含刚试过的那一份），按修改时间从新到旧
