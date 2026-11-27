// base
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { 备份 } from './backup.mjs'
import { 校验 } from './io.mjs'

export const 状态 = {
  会话API: null,
  会话控: null,
  宿主ctx: null,
  账库: undefined,
}


export const 家 = os.homedir()
// 备份、日志、校验器都放这里；要换位置设 SELECTIVE_TRIM_HOME
export const 数据根 = process.env.SELECTIVE_TRIM_HOME || path.join(家, '.dsh', 'selective-trim')
export const 会话根 = path.join(家, '.dsh', 'sessions')
export const 投影根 = path.join(家, '.dsh', 'storages', 'session_projcache', 'sessions')
export const 备份根 = path.join(数据根, 'backups')
export const 日志文件 = path.join(数据根, 'selective-trim.log')
// billion-context 的账库；非默认安装位置设 BILLION_CONTEXT_DIR
// 宿主自带的会话格式校验器是可选的：找得到就校验，找不到就只告警（可用 DSH_PERSIST_WORKER 指定）
export const 校验器 = [
  process.env.DSH_PERSIST_WORKER,
  path.join(数据根, 'persist-verify', 'lib', 'worker.cjs'),
  process.env.DSH_ROOT &&
    path.join(process.env.DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'worker.cjs'),
].find((p) => p && fs.existsSync(p)) || ''
export const 每帧行数 = 400
// 同类注入保留最近几份，更早的折叠成一行占位：5 份能兜住「旧记忆快照被压缩过」「只出现一次的系统指令」两处损失
export const 骨架 = new Set(['turn/start', 'step/start', 'step/end', 'turn/end'])
// 表面事件：内容被删掉的这些要改成 append，且不能带跨记录坐标
export const 表面 = new Set(['user/message', 'assistant/message', 'system/message', 'tool/result'])
export const 工具类 = new Set(['tool/call', 'tool/result'])
export const 带坐标字段 = ['sourceEventSeqs', 'surfaceOp', 'messageSeqs', 'sourceEventSeq']

export function 字时(ms) {
  const d = new Date(ms)
  const 补 = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}`
}

// 按「时间空档」把会话切成若干工作段：空档超过 90 分钟就断开
export const 窗口token = 1048576 // deepseek-flash 的实测有效窗口（宿主 413 报错里写的数）
export const zstd魔 = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 一个 zstd 帧从 起 开始到哪结束（RFC 8878：帧头 + 块序列 + 可选校验和）
// 不能靠 indexOf 找魔数：压缩数据里也可能出现同样的 4 个字节
export const 折叠上限 = 780000 // 窗口 1048576、ACP 预留后 792576，留一点余量
export const 需 = createRequire(import.meta.url)
export let 账库 = undefined
export const 注入头表 = [
  { 类: '记忆快照', 头: /^MNEMON RUNTIME MEMORY SNAPSHOT/ },
  { 类: '运行上下文', 头: /^Current runtime context\./ },
  { 类: '时间采样', 头: /^Time sampled while preparing/ },
  { 类: 'mnemon 提示', 头: /^\[MNEMON\]/ },
  { 类: '系统提醒', 头: /^\[系统提醒\]/ },
  { 类: '技能清单', 头: /^<available_skills>/ },
  { 类: '工作区说明', 头: /^Instructions from:/ },
  { 类: 'system-reminder', 头: /^<system-reminder>/ },
]

export const 备份保留 = 10
// 本次宿主进程的启动时刻（插件热重载时不变），用来判断「等重启」标记是不是这一轮宿主留下的
export const 本次进程起 = Math.round(Date.now() - process.uptime() * 1000)
export const 待重启文件 = path.join(备份根, 'pending-restart.json')

export const ACP目录 =
  process.env.BILLION_CONTEXT_DIR || path.join(家, '.local', 'share', 'billion-context', 'sessions')
export const ACP库 = path.join(ACP目录, 'index.db')
// 账本里的 session_id 有两种写法：带 `session-` 前缀的、和不带的（自定义 id），两个都要试。
export const 提问模板 = [
  '帮我按「工作内容」把我这一整段上下文切一下，输出一张表。要求：',
  '1. 每行一个工作内容，写清：工作内容 / 大约占用（K token） / 内容（那一段具体在干什么，举两三个代表性动作或产物）；',
  '2. 按占用从大到小排，最后单列一行「摘要块本身」，那是之前压缩出来的记忆；',
  '3. 表下面写一条建议：哪些行可以扔、哪些结论要留，说清大概能压到多少 K；',
  '4. 只按你实际看到的上下文估，别编。',
].join('\n')

// 走宿主自己的入口把话发进会话：sessionController.resolveAgent(id) → agent.followup(message)
// （宿主 API 的 session.prompt 内部也是这么做的，见 dsh-api-session-controller/lib/index.js）
export const 表视图文件 = path.join(备份根, '表视图.json')

export function 读体(req) {  return new Promise((好, 坏) => {
    let 数 = ''
    req.on('data', (c) => {
      数 += c
      if (数.length > 1e6) 坏(new Error('请求体太大'))
    })
    req.on('end', () => {
      try {
        好(数 ? JSON.parse(数) : {})
      } catch (e) {
        坏(e)
      }
    })
    req.on('error', 坏)
  })
}

// 把内部异常翻成「发生了什么 + 你该怎么做」。面板直接把这两段话显示给用户。
export function 用户话(e) {
  const m = e instanceof Error ? e.message : String(e)
  const 含 = (...词) => 词.some((w) => m.includes(w))

  if (含('宿主的会话接口', '等 DSH 重启完再用它')) {
    return {
      说: '现在没法确认这个会话是不是正开着。为了不弄坏它，这次没有动文件。',
      下一步: '把 DSH 完全关掉再打开（不是刷新页面），然后回到这个面板再点一次。',
    }
  }
  if (含('正在宿主里跑着', '刚打开过')) {
    return {
      说: '宿主内存里还挂着这个会话，所以这次没有动文件。它不一定是你打开的——DSH 重启后会自己把几条会话装回内存，切到别的会话也不会把它卸下来。',
      下一步: '两条路：①重启 DSH，重启后别打开这个会话，直接来清（最稳）；②点下面的「继续（结束后必须重启）」，做完立刻重启，重启前不要在那个会话里说话。',
    }
  }
  if (含('还没清够')) {
    return {
      说: m.replace(/^还没清够：/, '清完之后还是太大：'),
      下一步: '在表格里多勾几行、一次清掉更多，或者分两次清。目标是压到 78 万 token 以下。',
    }
  }
  if (含('没有勾选', '先勾几段')) {
    return { 说: '这次没有选中任何要清理的内容。', 下一步: '在表格最左边勾上想清理的那几行，再点下面的按钮。' }
  }
  if (含('没有对应块', '没有记忆块')) {
    return {
      说: '这条会话在压缩插件里还没有可用的压缩记忆。',
      下一步: '改用「转移记录」把这几段搬去新会话，或者用「工具结果」清掉工具输出。',
    }
  }
  if (含('校验', 'corrupt')) {
    return {
      说: '删完的文件没通过宿主的格式检查，所以没有替换原文件。',
      下一步: '换个方式清一次（比如先用「工具结果」）；反复失败就把这段提示发给我。',
    }
  }
  if (含('会话日志里只有表头', '读出来是空')) {
    return { 说: '这条会话的日志现在读不出内容。', 下一步: '过几十秒再点一次；还不行就先重启 DSH。' }
  }
  if (含('EBUSY', 'EPERM', 'EACCES')) {
    return { 说: '文件正被别的程序占着，写不进去。', 下一步: '关掉 DSH 再操作；如果还不行，把这段提示发给我。' }
  }
  if (含('ENOENT')) {
    return { 说: '找不到对应的文件（会话或备份）。', 下一步: '刷新一下面板；如果刚在别处删过文件，重启 DSH 让列表重新读一遍。' }
  }
  return { 说: '这次没能完成：' + m, 下一步: '换个操作再试一次；如果反复失败，把这段提示发给我。' }
}

export function 记(行) {
  try {
    fs.appendFileSync(日志文件, `${new Date().toISOString()} ${行}\n`)
  } catch {}
}
