import { 重编轮步 } from './clean.mjs'

// 从中间某段搬出来的记录没有完整的轮/步骨架，工具调用也可能只剩一半：
// 宿主据此会报「system 头位置错」「unresolved tool call」「没有声明过的调用」一串错。
// 这里整理成一条宿主能加载、且工具调用两侧自洽的链。

function 合成流(时, 正文) {
  return [
    { type: 'chunk', time: 时, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 时, index: 0, dt: [], texts: [正文] },
    { type: 'chunk', time: 时 + 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 正文 } } },
  ]
}

const 带轮步 = new Set(['user/message', 'assistant/message', 'system/message', 'tool/call', 'tool/result'])
const 骨架 = new Set(['turn/start', 'step/start', 'step/end', 'turn/end'])

const 块id = (b) => b.id || b.toolCallId

const 声明们 = (e) =>
  e.type === 'assistant/message'
    ? (e.data?.message?.content || []).filter((b) => b.type === 'tool-call' && 块id(b)).map((b) => 块id(b))
    : []

// 从消息里摘掉指定的调用块；如果一条消息摘完没有正文，返回 null 表示整条丢
function 摘调用(e, 丢) {
  const 块 = e.data?.message?.content || []
  if (!块.some((b) => b.type === 'tool-call' && 丢.has(块id(b)))) return e
  const 正文 = 块
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
    .trim()
  if (!正文) return null
  const 份 = JSON.parse(JSON.stringify(e))
  份.data.message.content = [{ type: 'text', text: 正文 }]
  份.data.stream = 合成流(Number(e.time) || Date.now(), 正文)
  delete 份.data.usage
  delete 份.data.interrupted
  if (份.data.message.source) delete 份.data.message.source.replayState
  return 份
}

// 工具两侧对齐：调用必须有结果、且必须被某条 assistant 消息声明过。
// 缺结果的调用先从消息里摘掉；摘完再算「还剩哪些声明」，剩下没人声明的调用/结果记录一并丢。
function 修工具(事件) {
  const 有结果 = new Set()
  for (const e of 事件) {
    if (e.type !== 'tool/result') continue
    const id = e.data?.callId || e.data?.message?.toolCallId
    if (id) 有结果.add(id)
  }
  const 一步 = []
  for (const e of 事件) {
    if (e.type === 'assistant/message') {
      const 坏 = new Set(声明们(e).filter((id) => !有结果.has(id)))
      if (坏.size) {
        const 改 = 摘调用(e, 坏)
        if (改) 一步.push(改)
        continue
      }
    }
    一步.push(e)
  }
  // 之前被别处改过的消息可能留着没结果的调用块：按「有结果」再摘一遍
  const 二步 = []
  for (const e of 一步) {
    if (e.type === 'assistant/message') {
      const 坏 = new Set(声明们(e).filter((id) => !有结果.has(id)))
      if (坏.size) {
        const 改 = 摘调用(e, 坏)
        if (改) 二步.push(改)
        continue
      }
    }
    二步.push(e)
  }
  const 已声明 = new Set()
  for (const e of 二步) for (const id of 声明们(e)) 已声明.add(id)
  // 声明里没有结果的（理论上已摘干净）也排除掉，避免留下「声明了但没结果」的调用记录
  return 二步.filter((e) => {
    if (e.type !== 'tool/call' && e.type !== 'tool/result') return true
    const id = e.data?.callId || e.data?.message?.toolCallId
    return !id || (已声明.has(id) && 有结果.has(id))
  })
}

// 骨架重排：丢掉原来的 turn/step 事件，按顺序重生成；system 头固定落在第一轮第一步里。
export function 整理副本(事件, 系统) {
  const 净 = 修工具(事件).filter((e) => !骨架.has(e.type))
  const 出 = []
  let 轮 = 1
  let 步 = 1
  let 有内容 = false
  let 本轮的助手 = false
  // 开步只开一步；轮的开头单独由 开轮 负责，别混在一起（否则每新起一步都会多出一条 turn/start）
  const 开轮 = () => {
    出.push({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 轮 } })
    步 = 1
    本轮的助手 = false
  }
  const 开步 = () => {
    出.push({ type: 'step/start', seq: 0, time: Date.now(), data: { turn: 轮, step: 步 } })
    if (轮 === 1 && 步 === 1 && 系统) {
      出.push({ ...JSON.parse(JSON.stringify(系统)), surfaceOp: 'append', data: { ...(系统.data || {}), turn: 1, step: 1 } })
      有内容 = true
    }
  }
  const 收步 = () => {
    if (!有内容) return
    出.push({ type: 'step/end', seq: 0, time: Date.now(), data: { turn: 轮, step: 步 } })
    有内容 = false
  }
  开轮()
  开步()
  for (const e of 净) {
    if (e.type === 'system/message') continue
    if (e.type === 'user/message' && 本轮的助手) {
      收步()
      出.push({ type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 轮, reason: { kind: 'completed' } } })
      轮 += 1
      开轮()
      开步()
    }
    if (e.type === 'assistant/message' && 有内容 && 出[出.length - 1].type === 'tool/result') {
      收步()
      步 += 1
      开步()
    }
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result'].includes(份.type)) 份.surfaceOp = 'append'
    if (带轮步.has(份.type)) 份.data = { ...(份.data || {}), turn: 轮, step: 步 }
    if (份.type === 'assistant/message') 本轮的助手 = true
    有内容 = true
    出.push(份)
  }
  收步()
  出.push({ type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 轮, reason: { kind: 'completed' } } })
  return 出.map((e, i) => ({ ...e, seq: i }))
}

// 复制/转移的正确切法：不拆轮步，直接按「整轮」取片段。
// 勾选的时间段常常从半轮中间开始、又在半轮中间结束；按整轮扩出去，
// 宿主需要的 turn/start→step→turn/end 骨架就都在手里，工具调用也不会只剩一半，
// 不用再靠 整理副本 去猜，也就不会把声明了却没结果的调用连带正文一起丢掉。
export function 整轮片段(体, 区间) {
  const 时 = (e) => Number(e.time || 0)
  const 段 = []
  let 起 = -1
  let 命中 = false
  for (let i = 0; i < 体.length; i += 1) {
    const e = 体[i]
    if (e.type === 'turn/start') {
      起 = i
      命中 = false
    }
    if (起 < 0) continue
    if (区间.some(([a, b]) => 时(e) >= a && 时(e) <= b)) 命中 = true
    if (e.type === 'turn/end') {
      if (命中) 段.push([起, i])
      起 = -1
    }
  }
  // 末尾没有 turn/end 的半轮（会话还在跑）也算进来，别把它整轮丢掉
  if (起 >= 0 && 命中) 段.push([起, 体.length - 1])
  if (!段.length) return []
  // 相邻段合并，避免同一轮出现两次
  const 合 = []
  for (const s of 段) {
    const 前 = 合[合.length - 1]
    if (前 && s[0] <= 前[1] + 1) 前[1] = Math.max(前[1], s[1])
    else 合.push([...s])
  }
  const 出 = []
  for (const [a, b] of 合) for (let i = a; i <= b; i += 1) 出.push(体[i])
  return 出
}

// 把整轮片段规整成能直接落盘的会话事件：清跨记录坐标、补受保护的系统头、
// 轮/步重排、seq 从 0 连续。
export function 规整整轮(事件, 系统) {
  // 这几类带跨记录记账（developer 头、session-log 水位、inbox 撤销、图片占位），
  // 搬进新会话就会指向不存在的旧坐标，直接丢；正文都在 user/assistant 里。
  const 丢 = new Set(['developer/message', 'agent/inbox/spliced', 'image/offload'])
  const 留 = 事件.filter((e) => !丢.has(e.type) && !String(e.type).startsWith('session-log-'))
  const 出 = []
  let 有系统 = false
  for (const e of 留) {
    // 一条会话只允许一条系统头；第二条夹在中间会被判成「没有前置 user 的 system 更新」
    if (e.type === 'system/message' && 有系统) continue
    const 份 = JSON.parse(JSON.stringify(e))
    delete 份.sourceEventSeqs
    delete 份.surfaceOp
    if (['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(份.type)) 份.surfaceOp = 'append'
    if (份.type === 'system/message') 有系统 = true
    出.push(份)
  }
  // 宿主要求表面第一条是受保护的系统头；原片段里没有就借源会话那一条，塞进第一个 step
  if (!有系统 && 系统) {
    const 头 = JSON.parse(JSON.stringify(系统))
    delete 头.sourceEventSeqs
    头.surfaceOp = 'append'
    const 位 = 出.findIndex((e) => e.type === 'step/start')
    if (位 >= 0) {
      const 轮 = 出[位].data?.turn
      const 步 = 出[位].data?.step
      头.data = { ...(头.data || {}), turn: 轮, step: 步 }
      出.splice(位 + 1, 0, 头)
    } else {
      出.unshift(头)
    }
  }
  重编轮步(出)
  return 出.map((e, i) => ({ ...e, seq: i }))
}
