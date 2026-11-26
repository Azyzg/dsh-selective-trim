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

const 声明们 = (e) =>
  e.type === 'assistant/message'
    ? (e.data?.message?.content || []).filter((b) => b.type === 'tool-call' && b.toolCallId).map((b) => b.toolCallId)
    : []

// 从消息里摘掉指定的调用块；如果一条消息摘完没有正文，返回 null 表示整条丢
function 摘调用(e, 丢) {
  const 块 = e.data?.message?.content || []
  if (!块.some((b) => b.type === 'tool-call' && 丢.has(b.toolCallId))) return e
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
  const 开步 = () => {
    出.push({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 轮 } })
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
  开步()
  for (const e of 净) {
    if (e.type === 'system/message') continue
    if (e.type === 'user/message' && 本轮的助手) {
      收步()
      出.push({ type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 轮, reason: { kind: 'completed' } } })
      轮 += 1
      步 = 1
      本轮的助手 = false
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
