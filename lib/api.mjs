// api
import fs from 'node:fs'
import path from 'node:path'
import { 分析, 分析文件, 分段 } from './analysis.mjs'
import { 宿主投问 } from './ask.mjs'
import { 列备份, 备份, 读待重启, 还原 } from './backup.mjs'
import { 状态, 用户话, 窗口token, 记, 读体 } from './base.mjs'
import { 执行去重, 执行清除区间, 重建 } from './clean.mjs'
import { 保留份数, 折叠注入, 统计注入 } from './inject.mjs'
import { 写会话, 宿主校验, 文本, 校验, 读会话 } from './io.mjs'
import { 过闸 } from './ledger.mjs'
import { 执行清旧轮, 执行记忆区间, 执行记忆替换 } from './ops.mjs'
import { 列会话, 找会话 } from './sessions.mjs'
import { 写表模板, 写表视图, 恢复表视图, 时间线, 构提问, 表文件, 解析表文件, 读表视图 } from './table.mjs'
import { 执行复制区间, 执行转移区间, 执行转移记录 } from './transfer.mjs'

export async function 试清除(文件, 键表) {
  const { 头, 体 } = 读会话(文件)
  const 段 = 分段(体)
  const 目标 = [...new Set(键表.map(Number))].filter((n) => n >= 0 && n < 段.length)
  const 范围 = 目标.map((n) => [段[n].起, 段[n].到])
  const { 前置, 其余 } = 重建(体, 范围)
  过闸(id, 前置)
  const 全部 = [...前置, ...其余].map((e, i) => ({ ...e, seq: i }))
  const 出口 = 文件 + '.out'
  写会话(头, 全部, 出口)
  const 查 = await 校验(出口)
  return { 出口, 问题: 查.问题, 事件: 查.事件, 段: 段.length, 删了: 目标.length, 字节: fs.statSync(出口).size }
}

export async function 处理请求(req, res) {
  {
      const 回 = (码, 对象) => {
        res.writeHead(码, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(对象))
      }
      try {
        const u = new URL(req.url, 'http://x')
        // 宿主按前缀挂载，pathname 会带着 /dsh-selective-trim；本地服务则是裸路径
        let 径 = u.pathname
        if (径 === '/dsh-selective-trim') 径 = '/'
        else if (径.startsWith('/dsh-selective-trim/')) 径 = 径.slice('/dsh-selective-trim'.length)
        try { 径 = decodeURI(径) } catch {}
        if (req.method === 'GET' && 径 === '/debug') {
          const 会话API2 = 状态.会话API
          const 名 = (o) => (o ? Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((k) => typeof o[k] === 'function') : [])
          const 全 = (会话API2 && typeof 会话API2.list === 'function') ? 会话API2.list() : []
          const 条 = Array.isArray(全) ? 全 : []
          const 结果 = {
            有接口: !!会话API2,
            服务方法: 名(会话API2),
            存活条数: 条.length,
            存活项: 条.slice(0, 6).map((e) => String(e && (e.id ?? e.header?.id))),
            逐个: [],
          }
          for (const s of 列会话()) {
            const 真 = 'session-' + s.id
            let 有 = null
            try { 有 = !!(会话API2.get && (await 会话API2.get(真))) } catch (e) { 有 = '错:' + String(e.message || e) }
            结果.逐个.push({ id: s.id, 标题: s.标题 || s.首句 || '', get: 有 })
          }
          return 回(200, 结果)
        }

        if (req.method === 'GET' && 径 === '/sessions') {
          const 等重启 = 读待重启()
          const 列表 = 列会话()
            .map((s) => ({
              id: s.id,
              标题: s.标题,
              首句: s.首句,
              改动: s.改动,
              字节: s.字节,
              说明: s.说明,
              工作区: s.工作区,
              占用: s.占用,
              占比: s.占比,
              账算: s.账算,
              账token: s.账token,
              初算: s.初算,
              折叠账: s.折叠账,
              轮数: s.轮数,
              待重启: 等重启[s.id]?.动作 || '',
            }))
            .sort((a, b) => b.改动 - a.改动)
          return 回(200, { ok: true, 窗口: 窗口token, 会话: 列表 })
        }
        if (req.method === 'GET' && 径 === '/analyze') return 回(200, { ok: true, ...分析(u.searchParams.get('sid')) })
        if (req.method === 'GET' && 径 === '/backups') {
          const 用 = u.searchParams.get('sid')
          const 全 = 列备份()
          return 回(200, { ok: true, 备份: 用 ? 全.filter((b) => b.名.includes(用.replace(/^session-/, ''))) : 全 })
        }
        if (req.method === 'GET' && 径 === '/inject') {
          const s = 找会话(u.searchParams.get('sid'))
          const { 体 } = 读会话(s.文件)
          return 回(200, { ok: true, ...统计注入(体) })
        }
        if (req.method === 'POST' && 径 === '/ask') {
          const b = await 读体(req)
          const s = 找会话(b.sid)
          // 清过/还原过的会话要等宿主重启才安全，这期间连投递也别做
          const 待 = 读待重启()[String(s.id).replace(/^session-/, '')]
          if (待) return 回(409, { ok: false, 错: `这个会话${待.动作 || '清'}过了，等 DSH 重启完再用它` })
          // 插件先切好粗颗粒的段，再放一张空表；会话按工作内容自己定行，填进表里
          const 分析 = 分析文件(s.文件)
          // 先放一张空表给会话填，再让它按表填；填完面板读这个文件
          const 表路径 = 表文件(s.文件)
          if (!b.文本) 写表模板(s.标题 || s.id, 表路径)
          const 题 = b.文本 ? String(b.文本) : 构提问(分析.时间线, s.标题 || s.id, 表路径, 分析.总token)
          // 先走宿主 RPC：真的把这句话发进那个会话并等它回话；拿不到 API 才退回写文件
          const 走宿主 = await 宿主投问(s.文件, 题, req)
          if (走宿主) {
            // 表由会话写进文件，面板读回来；文件没填出东西就把原文交给用户看
            const 解析 = 解析表文件(表路径, 分析.段, new Date(分析.段[0]?.起ms || Date.now()).getFullYear())
            // 服务端先存一份：浏览器中途切走、请求断了也不会丢，回来一问就有
            if (解析?.表?.length) {
              写表视图({
                sid: s.id,
                会话名: s.标题 || s.id,
                表: 解析.表,
                建议: 解析.建议 || '',
                原文: 走宿主.文本 || '',
                时: Date.now(),
              })
            }
            return 回(200, {
              ok: true,
              ...走宿主,
              事件: 0,
              窗口: 分析.窗口,
              段数: 分析.段.length,
              表: 解析?.表 || null,
              建议: 解析?.建议 || '',
              表文件: 表路径,
            })
          }
          // 不再退回「往文件里塞一条 user/message」：那会跟正在运行的宿主抢同一个文件，之前把会话写坏过
          记(`/ask 没投出去：host=${req?.headers?.host || ''} cookie=${req?.headers?.cookie ? '有' : '没有'} 状态.会话控=${状态.会话控 ? '有' : '没有'}`)
          return 回(503, { ok: false, 错: '宿主会话接口不可用，暂时不能投递（不走改文件那条路了）' })
        }
        if (req.method === 'GET' && 径 === '/table') {
          const 存 = 读表视图()
          if (存 && Array.isArray(存.表) && 存.表.length) return 回(200, { ok: true, 表: 存 })
          return 回(200, { ok: true, 表: 恢复表视图() })
        }
        if (req.method === 'POST' && 径 === '/table') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...写表视图(b) })
        }
        if (req.method === 'POST' && 径 === '/dedupe') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...(await 执行去重(b.sid, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/clean') {
          const b = await 读体(req)
          const 模式 = ['tools', 'drop', 'memory', 'move', 'copy'].includes(b.模式) ? b.模式 : 'all'
          if (模式 === 'memory') return 回(200, { ok: true, ...(await 执行记忆区间(b.sid, b.区间, undefined, !!b.强制)) })
          if (模式 === 'move') return 回(200, { ok: true, ...(await 执行转移区间(b.sid, b.区间, !!b.强制)) })
          if (模式 === 'copy') return 回(200, { ok: true, ...(await 执行复制区间(b.sid, b.区间)) })
          const 区间 = Array.isArray(b.区间) ? b.区间 : []
          if (!区间.length) return 回(400, { ok: false, 错: '没有给时间段（区间）' })
          return 回(200, { ok: true, 模式, ...(await 执行清除区间(b.sid, 区间, 模式, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/clean-old') {
          const b = await 读体(req)
          if (b.模式 === 'memory') {
            return 回(200, { ok: true, ...(await 执行记忆替换(b.sid, b.保留轮数, undefined, !!b.强制)) })
          }
          if (b.模式 === 'move') {
            return 回(200, { ok: true, ...(await 执行转移记录(b.sid, b.保留轮数, !!b.强制)) })
          }
          return 回(200, { ok: true, ...(await 执行清旧轮(b.sid, b.保留轮数, b.模式, !!b.强制)) })
        }
        if (req.method === 'POST' && 径 === '/restore') {
          const b = await 读体(req)
          return 回(200, { ok: true, ...(await 还原(b.名, !!b.强制)) })
        }
        return 回(404, { ok: false, 错: `未知路径 ${u.pathname}` })
      } catch (e) {
        const 话 = 用户话(e)
        try {
          记(`${req.method} ${u.pathname} 失败：${e instanceof Error ? e.message : String(e)}`)
        } catch {}
        const 体 = { ok: false, 错: 话.说, 下一步: 话.下一步 }
          if (e && e.活会话) 体.活着 = true
          return 回(500, 体)
      }
  }
}

// ---- ctx_dedupe 工具（原 dsh-ctx-dedupe 的功能，2026-11-17 并进来） ----
// scan：只统计重复系统注入；apply：折叠后另存一份 <会话>.staged.zstd，不覆盖原文件。
export function 最近会话() {
  try {
    return 列会话()[0]?.文件 || ''
  } catch {
    return ''
  }
}

export function 注册去重工具(ctx) {
  if (!ctx?.tools?.register) {
    记('没有 tools 服务，ctx_dedupe 跳过')
    return
  }
  ctx.tools.register({
    name: 'ctx_dedupe',
    description:
      '把会话日志里重复注入的「记忆快照 / 运行上下文 / system-reminder / 系统提醒」折叠成一行（离线去重）。\n'
      + 'action=scan 只统计不动文件；action=apply 生成折叠后的副本（<会话>.staged.zstd），不覆盖正式文件。\n'
      + '同一个面板在 Web UI 侧栏「清上下文」里，带备份与还原。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'apply'], description: 'scan 只统计；apply 生成副本' },
        sessionPath: { type: 'string', description: '可选：指定 session.v4.jsonl.zstd 路径，默认取最近写入的会话' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const 动作 = String(args?.action || 'scan').trim()
      const 文件 = args?.sessionPath ? String(args.sessionPath) : 最近会话()
      if (!文件 || !fs.existsSync(文件)) return '找不到会话日志文件。可以手动传 sessionPath。'
      const { 头, 体 } = 读会话(文件)
      const 统 = 统计注入(体)
      if (动作 === 'scan') {
        const 行 = 统.清单.map((x) => `- ${x.类}：${x.处数} 处，可省 ${Math.round(x.可省字 / 1000)}k 字`).join('\n')
        return `扫描完成（${path.basename(path.dirname(文件))}）\n事件 ${体.length} 条，重复注入 ${统.总处} 处，可省约 ${Math.round(统.可省字 / 1000)}k 字（留最新 ${统.保留份数} 份）\n${行}`
      }
      const { 体: 新体, 折叠, 省字 } = 折叠注入(体)
      if (!折叠) return '没有可折叠的重复注入。'
      const 规整 = 重建(新体, [])
      const 全部 = [...规整.前置, ...规整.其余].map((e, i) => ({ ...e, seq: i }))
      const 出 = `${文件}.staged.zstd`
      写会话(头, 全部, 出)
      const 查 = await 宿主校验(出, 全部.length)
      if (查 && 查.ok === false) {
        try {
          fs.rmSync(出, { force: true })
        } catch {}
        return `宿主校验没过，副本已删：${查.message || '未知'}`
      }
      return `已生成去重副本（没有动原文件）：${出}\n折叠 ${折叠} 处，省约 ${Math.round(省字 / 1000)}k 字，事件 ${全部.length} 条，宿主校验通过。\n要用的话走面板「折叠重复注入」，它会自动备份并替换。`
    },
  })
}
