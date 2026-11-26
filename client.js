window.__ModuleLoader__.load({
  id: 'dsh-selective-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const 色 = {
      边框: 'rgba(255,255,255,0.12)',
      次: 'rgba(255,255,255,0.58)',
      危: '#e2564d',
      警: '#d8a13a',
      好: '#4ea87a',
      行: 'rgba(255,255,255,0.04)',
      选中: 'rgba(255,255,255,0.08)',
    }
    const 钮 = {
      border: `1px solid ${色.边框}`,
      background: 'transparent',
      color: 'inherit',
      borderRadius: 8,
      padding: '5px 10px',
      fontSize: 12,
      cursor: 'pointer',
    }
    const 小字 = { fontSize: 11, color: 色.次 }
    const 服务基 = '/dsh-selective-trim'
    // 帮助正文的出厂默认；改过的存在服务端（数据根/help.md）
    // 出厂默认正文 = 作者自己写的那份（别再改这里的文字，只换内容来源）
    const 默认帮助文 = "  会话体积过大的坏处（个人经验，只供参考）：\n1.上下文占用较高时，模型注意力会降低，并更可能失忆。超窗会直接无法使用。\n2.请求体过大，你发送信息后模型会延迟收到（“暂未响应”或超长“分析需求”），严重时直接卡住（这个不太常见）。\n3.会话总体积过大，打开会话需要更长时间，并增加报错时的修理难度。\n\n（billion-context下）模型对对话的记忆（即出网内容）可分三层，每层范围大小由层内对话的体积决定：\n1.详细层。模型记得对话原文和工具结果。对于一直工作的会话，大概包括的最近3-8轮，一直简短闲聊的话可能有20轮以上。\n2.摘要层。模型主要读插件给它的简短摘要。翻这层的工具结果比较贵，模型只在少数必要的情况下翻找原对话。对于工作会话，除非近期任务比较复杂或易错，可以考虑保留最近20轮-折叠记忆；对于提供情感价值的会话，可以考虑保留30~40轮-清工具结果。\n3.文件层。这层连摘要都只传出寥寥几笔，原生历史内容和外界文本没什么区别。只有在用户主动提出要求，并提供关键词（必须在原文里有）时才会进行效率极低的检索。这层内容就是会话的赘肉，而赛博鲸鱼并不需要脂肪，完全可以整轮删除。真要找，在备份里找和在这层找是差不多的。\n当然，模型“我记下了”的日志和一些记忆插件提供的文本不受这些影响。但要注意，dsh给模型记忆设限可不是闲着没事，体量过于巨大的额外记忆不仅烧token，还会分散模型注意力。\n\n  如果因为本插件，会话出了任何问题，还原备份就可以解决。使用插件清理后，在重启 dsh（只关窗口不行）之前不要点开会话，不然就等着还原到备份吧。\n\n  要清理带 ⚠ 会话，降低上下文占用，有三个参考方案：\n1.保留最近20~40轮-折叠记忆，让它在折叠账失效后仍不会立刻超窗，然后可以正常进行操作。如果不够，可以再保留50~120轮-删除整轮。\n2.让它算构成-选择想要保留的部分-转移记录，以后使用那个转出的会话。\n3.对于像我一样觉得读了交接文档的新会话没旧会话聪明的用户，可以只是把某方面工作的内容转出去，减少原会话之后的工作量。但要注意，这里如果选转出而不是复制，会使原会话压缩账失效。\n\n  如果只想清总体积，会简单很多。保留最近50~120轮-整轮删除，你很可能发现，没了早期对话历史，模型完全还是老样子。\n\n  关于问题“清理完，为什么显示上下文占用没变？”：\n- dsh面板的上下文占用是上一次请求实际发出去的体积，不是文件大小。清完要重启 DSH → 打开会话 → 发一句话，数字才会按新内容重算。\n- 带「·压」的会话，占用来自 billion-context 的折叠账；删文件只导致会话不去对接，不影响账。变化要等重启后过一轮，重建折叠账后才体现出来。"
    // 用户点了「仍然清理」之后，写操作带上这个标记，跳过「会话开着」的拦截
    let 强制态 = false
    const 设强制态 = (v) => { 强制态 = v }

    async function 请求(路径, 体) {
      const r = await fetch(
        服务基 + 路径,
        体
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...体, 强制: 强制态 }) }
          : { cache: 'no-store' },
      )
      const j = await r.json()
      if (j.ok) 强制态 = false
      if (!j.ok) {
    const e = new Error(j.错 || '请求失败')
    e.下一步 = j.下一步 || ''
    e.活着 = !!j.活着
    throw e
  }
      return j
    }

    const 占比色 = (p) => (p >= 70 ? 色.危 : p >= 40 ? 色.警 : 色.好)

    // 面板渲染抛错时保留现场：显示错误与堆栈，而不是整块空白
    class 兜底 extends React.Component {
      constructor(props) {
        super(props)
        this.state = { 错: null }
      }
      static getDerivedStateFromError(错) {
        return { 错 }
      }
      render() {
        const 错 = this.state.错
        if (!错) return this.props.children
        return h('div', { style: { padding: '12px 14px', fontSize: 12, lineHeight: 1.6, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } }, [
          h('div', { key: 't', style: { fontWeight: 600, fontSize: 14, marginBottom: 6, color: 色.危 } }, '面板渲染出错'),
          h('div', { key: 'm', style: { marginBottom: 8 } }, String(错?.message || 错)),
          h('pre', {
            key: 's',
            style: { ...小字, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 色.行, padding: 8, borderRadius: 6, maxHeight: 320, overflowY: 'auto' },
          }, String(错?.stack || '').split('\n').slice(0, 12).join('\n')),
          h('button', {
            key: 'r',
            style: { ...钮, marginTop: 10 },
            onClick: () => this.setState({ 错: null }),
          }, '重试'),
        ])
      }
    }


    function 工作台(props) {
      const [会话表, 设会话表] = useState([])
      const [窗口, 设窗口] = useState(1048576)
      const [当前, 设当前] = useState('')
      const [忙, 设忙] = useState('')
      const [错, 设错] = useState('')
      const [注, 设注] = useState('')
      const [活着, 设活着] = useState(false)
      const 设失败 = (e) => {
        设活着(!!e?.活着)
        设错(String((e && e.message) || e))
        设注(String((e && e.下一步) || ''))
      }
      const [结果, 设结果] = useState(null)
  const 动作名 = 结果?.还原 ? '还原' : 结果?.折叠 ? '折叠重复注入' : 结果?.清旧 ? '清旧轮次' : 结果?.模式 ? '清理' : '这次操作'
      const [备份表, 设备份表] = useState([])
      const [注入, 设注入] = useState(null)
      const [折确认, 设折确认] = useState(false)
      const [问确认, 设问确认] = useState(false)
      const [清确认, 设清确认] = useState(false)
      const [保留轮数, 设保留轮数] = useState(10)
      const [清旧模式, 设清旧模式] = useState('tools')
      const [提醒重启, 设提醒重启] = useState(false)
      const [帮开, 设帮开] = useState(false)
  const [帮文, 设帮文] = useState('')
  useEffect(() => {
    if (!帮开) return
    请求('/help')
      .then((j) => 设帮文(j.文本 && j.文本.trim() ? j.文本 : 默认帮助文))
      .catch(() => 设帮文(默认帮助文))
  }, [帮开])
  const 存帮 = async () => {
    try {
      await 请求('/help', { 文本: 帮文 })
      设帮开(false)
    } catch (e) {
      设错(String(e.message || e))
      设注(e.下一步 || '')
    }
  }
  const 复帮 = async () => {
    try {
      await 请求('/help', { 文本: '' })
      设帮文(默认帮助文)
    } catch (e) {
      设错(String(e.message || e))
      设注(e.下一步 || '')
    }
  }
      const [还确认, 设还确认] = useState('')
      const [等秒, 设等秒] = useState(0)
      const [载完, 设载完] = useState(false)
      const [勾, 设勾] = useState({})
      const [表确认, 设表确认] = useState('')
      const [预设, 设预设] = useState('')
      const [预设表, 设预设表] = useState([])
      const [视图, 设视图] = useState('列表')
      const [表数据, 设表数据] = useState(null)

      useEffect(() => {
        if (!忙) {
          设等秒(0)
          return
        }
        const 起 = Date.now()
        const t = setInterval(() => 设等秒(Math.round((Date.now() - 起) / 1000)), 1000)
        return () => clearInterval(t)
      }, [忙])

      const 拉会话 = useCallback(async () => {
        try {
          设载完(false)
          const j = await 请求('/sessions')
          设会话表(j.会话 || [])
          if (j.窗口) 设窗口(j.窗口)
          请求('/presets').then((r) => 设预设表(r.预设 || [])).catch(() => {})
          设载完(true)
        } catch (e) {
          设失败(e)
        } finally {
          设载完(true)
        }
      }, [])
      const 拉备份 = useCallback(async () => {
        try {
          const j = await 请求('/backups')
          设备份表(j.备份 || [])
        } catch (e) {
          设失败(e)
        }
      }, [])
      useEffect(() => {
        拉会话()
        拉备份()
      }, [拉会话, 拉备份])

      // 面板被关掉再打开时 React 会重新挂载，把「表」这一屏恢复回来：
      // 先看浏览器本地，没有就问插件自己要（换浏览器、清缓存也不丢）
      const 表存键 = 'dsh-selective-trim:表视图'
      const 装上表 = (v) => {
        if (!v || (!Array.isArray(v.表) && !v.原文)) return false
        设表数据(v)
        设视图('表')
        if (v.当前) 设当前(v.当前)
        设勾(v.勾 || {})
        return true
      }
      useEffect(() => {
        // 以插件那边为准：重启 DSH 后它会清掉旧表，这里就跟着回到列表，不再从 localStorage 复活
        void (async () => {
          try {
            const j = await 请求('/table')
            if (j.表) 装上表(j.表)
            else {
              try { localStorage.removeItem(表存键) } catch {}
            }
          } catch {}
        })()
      }, [])

      const 退出表 = () => {
        设视图('列表')
        设表数据(null)
        设结果(null)
        设错(''); 设注('')
        try {
          localStorage.removeItem(表存键)
        } catch {}
        void 请求('/table', { 退出: true }).catch(() => {})
      }

      // 勾选也记下来：离开界面再回来，勾的还是那些（浏览器一份、插件那边一份）
      useEffect(() => {
        if (视图 !== '表' || !表数据) return
        try {
          localStorage.setItem(表存键, JSON.stringify({ ...表数据, 勾 }))
        } catch {}
        void 请求('/table', { ...表数据, 勾 }).catch(() => {})
      }, [勾, 视图, 表数据])

      const 选会话 = (id) => {
        设当前(id)
        设注入(null)
        设结果(null)
        设错(''); 设注('')
        设折确认(false)
        设问确认(false)
        设清确认(false)
        void 拉注入(id)
      }

      const 折叠 = async () => {
        设忙('折叠重复注入')
        设错(''); 设注('')
        try {
          const j = await 请求('/dedupe', { sid: 当前 })
          设结果({ 折叠: j.折叠, 省字: j.省字, 备份: j.备份, 新字节: j.新字节, 事件: j.事件 })
          设折确认(false)
          设提醒重启(true)
          设注入(null)
          拉备份()
          拉会话()
        } catch (e) {
          设失败(e)
        } finally {
          设忙('')
        }
      }

      const 清旧轮 = async () => {
        if (!当前) return
        设忙(清旧模式 === 'drop' ? '整轮删除' : 清旧模式 === 'memory' ? '换成折叠记忆' : 清旧模式 === 'move' ? '转移记录' : '清旧轮次（工具结果）')
        设错(''); 设注('')
        try {
          const j = await 请求('/clean-old', { sid: 当前, 保留轮数: Number(保留轮数) || 0, 模式: 清旧模式 })
          设结果({ 清旧: j, 备份: j.备份 })
          设清确认(false)
          设提醒重启(true)
          拉备份()
          拉会话()
          设注入(null)
        } catch (e) {
          设失败(e)
        } finally {
          设忙('')
        }
      }

      const 提问 = async () => {
        if (!当前) return
        设忙('投提问')
        设错(''); 设注('')
        try {
          const j = await 请求('/ask', { sid: 当前 })
          设结果({ 提问: j })
          const 表 = Array.isArray(j.表) ? j.表 : []
          const 初勾 = Object.fromEntries(表.filter((r) => r.留 === '删').map((r) => [r.键, true]))
          设勾(初勾)
          if (表.length) {
            const 选 = 会话表.find((s) => s.id === 当前)
            const 数据 = { 表, 建议: j.建议 || '', 原文: j.文本 || '', 当前, 会话名: 选 ? 选.标题 || 选.首句 || 选.id : String(当前 || ''), 勾: 初勾, 时: Date.now() }
            设表数据(数据)
            设视图('表')
            try {
              localStorage.setItem(表存键, JSON.stringify(数据))
            } catch {}
          } else {
            // 表没填出东西：留在列表这一屏，把原文摆出来，别让人进一张空表
            设视图('列表')
            设表数据(null)
            try {
              localStorage.removeItem(表存键)
            } catch {}
            void 请求('/table', { 退出: true }).catch(() => {})
          }
          设表确认('')
          设清确认(false)
          设问确认(false)
          拉会话()
        } catch (e) {
          设失败(e)
        } finally {
          设忙('')
        }
      }

      const 拉注入 = async (id) => {
        try {
          设注入(null)
          const k = await 请求('/inject?sid=' + encodeURIComponent(id))
          设注入(k)
        } catch (e) {
          设失败(e)
        }
      }

      const 还原 = async (名) => {
        设忙('还原中')
        设错(''); 设注('')
        try {
          const j = await 请求('/restore', { 名 })
          设结果({ 还原: j.还原自 })
          设提醒重启(true)
          拉备份()
          拉会话()
        } catch (e) {
          设失败(e)
        } finally {
          设忙('')
        }
      }

      const 会话行 = (s) => {
        const 名 = String(s.标题 || s.首句 || '(空会话)').slice(0, 34)
        const 是当前 = s.id === 当前
        return h(
          'button',
          {
            key: s.id,
            onClick: () => 选会话(s.id),
            title: s.待重启 ? `已经${s.待重启}过，重启 DSH 后才会干净` : '',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              textAlign: 'left',
              padding: '6px 8px',
              border: 0,
              borderBottom: `1px solid ${色.行}`,
              background: 是当前 ? 色.选中 : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
              opacity: s.待重启 ? 0.55 : 1,
            },
          },
          [
            h('div', { key: 'n', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 名),
            h('div', { key: 'w', style: { ...小字, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.说明 || ''),
            s.待重启 ? h('div', { key: 'r', style: { ...小字, color: 色.危, whiteSpace: 'nowrap' } }, '等重启') : null,
            h('div', {
                key: 'p',
                title: s.账算
                  ? `压缩账里记的实际出网体积 ${((s.账token || 0) / 1000).toFixed(0)}K；如果压缩账失效、按正文重发会是 ${((s.初算 || 0) / 1000).toFixed(0)}K`
                  : `按正文估算 ${((s.初算 || 0) / 1000).toFixed(0)}K（这条还没有压缩账）`,
                style: { fontWeight: 600, color: s.占比 ? 占比色(s.占比) : 色.次, minWidth: 40, textAlign: 'right' },
              },
              s.占比 ? `${s.占比}%${s.账算 ? '·压' : ''}${s.账算 && s.初算 > 700000 ? ' ⚠' : ''}` : '—'),
            h('div', { key: 't', style: { ...小字, minWidth: 44, textAlign: 'right' } }, `${s.轮数 || 0} 轮`),
            h('div', { key: 'b', style: { ...小字, minWidth: 42, textAlign: 'right' } }, `${(s.字节 / 1048576).toFixed(1)}MB`),
          ],
        )
      }

      const 注入区 = () => {
        if (!注入 || !注入.总处) return null
        return h('div', { key: 'inj', style: { marginTop: 12, border: `1px solid ${色.边框}`, borderRadius: 8, padding: 8 } }, [
          h('div', { key: 'h', style: { fontSize: 12, fontWeight: 600 } },
            `重复系统注入：${注入.总处} 处，可省约 ${(注入.可省字 / 1000).toFixed(0)}k 字`),
          h('div', { key: 'l', style: { ...小字, marginTop: 4, lineHeight: 1.6 } },
            注入.清单.filter((x) => x.重复 > 0).slice(0, 6).map((x) =>
              h('div', { key: x.类 }, `${x.类}：${x.处数} 处（留最新 ${注入.保留份数 ?? 5} 份，省 ${(x.可省字 / 1000).toFixed(1)}k 字）`))),
          h('div', { key: 'f', style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 } }, [
            h('button', {
              key: 'b',
              style: { ...钮, borderColor: 折确认 ? 色.危 : 色.边框, color: 折确认 ? 色.危 : 'inherit' },
              disabled: !!忙,
              onClick: () => (折确认 ? 折叠() : 设折确认(true)),
            }, 折确认 ? '确认折叠？' : '折叠重复注入'),
            h('span', { key: 'n', style: 小字 }, `每类留最近 ${注入.保留份数 ?? 5} 份`),
          ]),
          h('div', { key: 't', style: { ...小字, marginTop: 4 } },
            '只压重复贴的运行上下文/记忆快照，不动对话。'),
        ])
      }

      const 清理选中 = async (模式) => {
        const 行 = (表数据?.表 || []).filter((r) => 勾[r.键])
        if (!行.length) {
          设错('先勾几段'); 设注('')
          return
        }
        const 区间 = 行.flatMap((r) => (Array.isArray(r.子) && r.子.length ? r.子 : [[r.起ms, r.止ms]]))
        if (!区间.length) {
          设错('这段没有时间范围，没法清'); 设注('')
          return
        }
        设忙(模式 === 'tools' ? '删工具结果' : 模式 === 'memory' ? '换成折叠记忆' : 模式 === 'copy' ? '复制记录' : 模式 === 'move' ? '转移记录' : '全删')
        设错(''); 设注('')
        设结果(null)
        try {
          const j = await 请求('/clean', { sid: 表数据?.当前 || 当前, 区间, 模式, 预设 })
          设结果(模式 === 'copy'
            ? { 复制: j.新id, 事件: j.事件 }
            : { 模式: j.模式, 剩余事件: j.剩余事件, 新字节: j.新字节, 备份: j.备份 })
          if (模式 !== 'copy') 设提醒重启(true)
          设勾({})
          设表确认('')
          拉会话()
          拉备份()
        } catch (e) {
          设失败(e)
        } finally {
          设忙('')
        }
      }

      const 构成表 = (提问结果) => {
        const 表 = 提问结果.表 || []
        if (!表.length) return null
        const 已勾 = 表.filter((r) => 勾[r.键]).length
        const 行 = (r) =>
          h('div', { key: r.键, style: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '5px 0', borderTop: `1px solid ${色.边框}` } }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: !!勾[r.键],
              disabled: !!忙,
              style: { marginTop: 3 },
              onChange: () => 设勾((p) => ({ ...p, [r.键]: !p[r.键] })),
            }),
            h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 'n', style: { fontSize: 12, textDecoration: 勾[r.键] ? 'line-through' : 'none' } }, r.名),
              r.内容 ? h('div', { key: 'd', style: { ...小字, marginTop: 2, lineHeight: 1.5 } }, `工具 ${r.内容}`) : null,
              h('div', { key: 'm', style: { ...小字, marginTop: 2, opacity: 0.8 } },
                `~${Math.round((r.token || 0) / 1000)}K · ${r.起} → ${r.止}`),
            ]),
            h('span', { key: 's', style: { ...小字, flexShrink: 0, color: r.留 === '删' ? 色.危 : 'rgba(255,255,255,0.5)' } }, r.留),
          ])
        return h('div', { key: 'tbl', style: { marginTop: 8 } }, [
          h('div', { key: 'h', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('div', { key: 't', style: { fontSize: 12, fontWeight: 600, flex: 1 } }, `它整理出来的构成（${表.length} 行，已勾 ${已勾}）`),
            h('button', { key: 'a', style: { ...钮, padding: '2px 6px' }, disabled: !!忙, onClick: () => 设勾(Object.fromEntries(表.map((r) => [r.键, true]))) }, '全选'),
            h('button', { key: 'z', style: { ...钮, padding: '2px 6px' }, disabled: !!忙, onClick: () => 设勾({}) }, '全不选'),
          ]),
          提问结果.建议 ? h('div', { key: 'g', style: { ...小字, marginTop: 4, lineHeight: 1.5 } }, `它的建议：${提问结果.建议}`) : null,
          h('div', { key: 'l', style: { marginTop: 4 } }, 表.map(行)),
          h('div', { key: 'ps', style: { ...小字, marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
            h('span', { key: 'l' }, '新会话预设：'),
            h('select', {
              key: 's',
              value: 预设,
              disabled: !!忙,
              style: { ...钮, padding: '2px 6px', cursor: 'default' },
              onChange: (e) => 设预设(e.target.value),
            }, [
              h('option', { key: '', value: '' }, '跟这条会话一样'),
              ...预设表.map((p) => h('option', { key: p.id, value: p.id }, p.名 ? `${p.名}（${p.id}）` : p.id)),
            ]),
            h('span', { key: 'h', style: { color: 'rgba(255,255,255,0.45)' } }, '只对「复制记录」「转移记录」生效'),
          ]),
          h('div', { key: 'f', style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } }, [
            h('button', {
              key: 't1',
              style: { ...钮, borderColor: 表确认 === 'tools' ? 色.危 : 色.边框, color: 表确认 === 'tools' ? 色.危 : 'inherit' },
              disabled: !!忙,
              onClick: () => (表确认 === 'tools' ? 清理选中('tools') : 设表确认('tools')),
            }, 表确认 === 'tools' ? `确认删这 ${已勾} 段的工具结果？` : '工具结果'),
            h('button', {
              key: 't3',
              style: { ...钮, borderColor: 表确认 === 'memory' ? 色.主 : 色.边框, color: 表确认 === 'memory' ? 色.主 : 'inherit' },
              disabled: !!忙,
              onClick: () => (表确认 === 'memory' ? 清理选中('memory') : 设表确认('memory')),
            }, 表确认 === 'memory' ? `确认换成记忆这 ${已勾} 段？` : '折叠记忆'),
            h('button', {
              key: 'tc',
              style: { ...钮, borderColor: 表确认 === 'copy' ? 色.主 : 色.边框, color: 表确认 === 'copy' ? 色.主 : 'inherit' },
              disabled: !!忙,
              onClick: () => (表确认 === 'copy' ? 清理选中('copy') : 设表确认('copy')),
            }, 表确认 === 'copy' ? `确认复制这 ${已勾} 段？` : '复制记录'),
            h('button', {
              key: 't4',
              style: { ...钮, borderColor: 表确认 === 'move' ? 色.主 : 色.边框, color: 表确认 === 'move' ? 色.主 : 'inherit' },
              disabled: !!忙,
              onClick: () => (表确认 === 'move' ? 清理选中('move') : 设表确认('move')),
            }, 表确认 === 'move' ? `确认搬走这 ${已勾} 段？` : '转移记录'),
            h('button', {
              key: 't2',
              style: { ...钮, borderColor: 表确认 === 'drop' ? 色.危 : 色.边框, color: 表确认 === 'drop' ? 色.危 : 'inherit' },
              disabled: !!忙,
              onClick: () => (表确认 === 'drop' ? 清理选中('drop') : 设表确认('drop')),
            }, 表确认 === 'drop' ? `确认整轮删掉这 ${已勾} 段？` : '整轮删除'),
          ]),
          h('div', { key: 'n', style: { ...小字, marginTop: 4 } },
            '「工具结果」只把工具输出换成一行占位；「折叠记忆」把这几段换成账里的压缩记忆；「复制记录」把这几段原样复制成一条新会话（这条不动，不用重启）；「转移记录」把这几段搬进一条新会话再从这条删掉；「整轮删除」直接连骨架删掉。动手前自动整份备份，出问题在下面还原。'),
        ])
      }

      const 备份区 = () => {
        const 裸id = (v) => String(v || '').replace(/^session-/, '')
      const 我的 = 备份表.filter((b) => 裸id(b.会话id) && 裸id(b.会话id) === 裸id(当前))
        return h('div', { key: 'bk', style: { marginTop: 10, border: `1px solid ${色.边框}`, borderRadius: 8, padding: 8 } }, [
          h('div', { key: 'h', style: { fontSize: 12, fontWeight: 600 } }, `这个会话的备份（${我的.length}）`),
          h('div', { key: 't', style: { ...小字, marginTop: 2, lineHeight: 1.5 } },
            '清除 / 折叠 / 还原之前，插件先把整个会话文件原样复制一份放这儿，最多留 10 份。点「还原」就把它拷回去。'),
          我的.length === 0
            ? h('div', { key: 'z', style: { ...小字, marginTop: 6 } }, '（还没有备份）')
            : h('div', { key: 'l', style: { maxHeight: 150, overflowY: 'auto', marginTop: 6 } },
              我的.map((b) =>
                h('div', { key: b.名, style: { display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' } }, [
                  h('div', { key: 'n', style: { ...小字, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    `${new Date(b.时间).toLocaleString('zh-CN', { hour12: false })} · ${(b.字节 / 1048576).toFixed(1)}MB · ${b.备注 || ''}`),
                  h('button', {
                    key: 'r',
                    style: { ...钮, padding: '2px 6px', borderColor: 还确认 === b.名 ? 色.危 : 色.边框, color: 还确认 === b.名 ? 色.危 : 'inherit' },
                    disabled: !!忙,
                    onClick: () => (还确认 === b.名 ? 还原(b.名) : 设还确认(b.名)),
                  }, 还确认 === b.名 ? '确认还原？' : '还原'),
                ])),
            ),
        ])
      }
      const 列表 = 会话表.length
        ? 会话表.map(会话行)
        : h('div', { key: 'none', style: { ...小字, padding: 10, cursor: 'default', userSelect: 'none' } },
          载完 ? '（没有可显示的会话）' : '正在读取会话…')

      const 当前项 = 会话表.find((s) => s.id === 当前)
      const 超四成 = 当前项 && 当前项.占比 >= 40

      // 投递成功后切到「表」这个界面；不点「退出」就一直在，从外面点回插件也回到这儿
      const 表页 = () => {
        const 名 = 表数据.会话名 || 表数据.当前 || ''
        return h('div', { style: { padding: '12px 14px', fontSize: 13, lineHeight: 1.5, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } }, [
          h('div', {
            key: 'hd',
            style: {
              display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between',
              marginBottom: 8, padding: '8px 10px', position: 'sticky', top: 0, zIndex: 2,
              background: 色.底 || 'rgba(0,0,0,0.55)', borderRadius: 8, border: `1px solid ${色.边框}`,
            },
          }, [
            h('div', { key: 't', style: { fontWeight: 600, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `${名} · 整理出来的构成`),
            h('button', {
              key: 'x',
              style: {
                ...钮, flexShrink: 0, fontSize: 13, fontWeight: 600, padding: '7px 16px',
                border: `1px solid ${色.好 || 色.边框}`, borderRadius: 8, cursor: 'pointer',
              },
              onClick: 退出表,
              title: '回到会话列表',
            }, '退出 ✕'),
          ]),
          h('div', { key: 'd', style: { ...小字, marginBottom: 6 } },
            '勾掉要清的段，再选「删工具结果」或「全删」。清理不会退出这个界面，清完可以接着看。'),
          错
          ? h('div', {
            key: 'e',
            style: {
              color: '#ffd7d7',
              background: '#3a1c20',
              border: '1px solid #a33b45',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.5,
              margin: '8px 0',
            },
          }, [
            h('div', { key: 'h', style: { fontWeight: 600, marginBottom: 2 } }, '没有执行'),
            h('div', { key: 'b' }, 错),
            注 ? h('div', { key: 'n', style: { marginTop: 6, color: '#ffc9c9' } }, '下一步：' + 注) : null,
            活着
              ? h('div', { key: 'f', style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } }, [
                h('button', {
                  key: 'b',
                  style: { ...钮, borderColor: 色.危, color: 色.危 },
                  onClick: () => {
                    设强制态(true)
                    设活着(false)
                    设错('')
                    设注('已允许强制清理：再点一次刚才那个操作，清完请立刻重启 DSH。')
                  },
                }, '仍然清理（清完必须重启）'),
                h('span', { key: 't', style: { ...小字, color: '#ffc9c9' } }, '点了它就直接改文件；改完务必重启，重启前不要在那个会话里说话'),
              ])
              : null,
          ])
          : null,
          忙 ? h('div', { key: 'w', style: { ...小字, margin: '6px 0' } }, `${忙}… ${等秒 ? 等秒 + ' 秒' : ''}`) : null,
          构成表(表数据),
          表数据.表 && 表数据.表.length
            ? null
            : h('div', { key: 'raw', style: { ...小字, marginTop: 6, lineHeight: 1.5 } }, '它没按格式回，下面是它的原话：'),
          表数据.表 && 表数据.表.length
            ? null
            : h('pre', { key: 'p', style: { ...小字, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.55, maxHeight: 360, overflowY: 'auto' } }, 表数据.原文 || '（没有回话）'),
          表数据.表 && 表数据.表.length && 表数据.原文
            ? h('details', { key: 'orig', style: { marginTop: 10 } }, [
              h('summary', { key: 's', style: { ...小字, cursor: 'pointer' } }, '看它写的完整回答'),
              h('pre', { key: 'p', style: { ...小字, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, maxHeight: 360, overflowY: 'auto', background: 'rgba(255,255,255,0.04)', padding: 8, borderRadius: 6 } }, 表数据.原文),
            ])
            : null,
          结果
            ? h('div', { key: 'ok', style: { marginTop: 10, border: `1px solid ${色.边框}`, borderRadius: 8, padding: 8, fontSize: 12 } }, [
              h('div', { key: 'a' }, 结果.模式 === 'memory' ? `换成了 ${结果.记忆块 ?? 0} 段压缩记忆，现在 ${结果.剩余事件 ?? 0} 条事件、${((Number(结果.剩余字节) || 0) / 1048576).toFixed(2)}MB` : 结果.模式 === 'move' ? `搬走了这几段，新会话是「${结果.新会话}」（${结果.新事件} 条事件、${结果.新大小}）；这条现在 ${结果.剩余事件} 条事件` : `${结果.模式 === 'tools' ? '已清工具结果' : '已整轮删掉这几段'}，剩 ${结果.剩余事件 ?? 0} 条事件、${((Number(结果.新字节) || 0) / 1048576).toFixed(2)}MB`),
              h('div', { key: 'b', style: { ...小字, marginTop: 4 } }, 结果.备份 ? `备份：${结果.备份}` : ''),
              结果.备份 ? h('div', { key: 'c', style: { ...小字, marginTop: 4 } }, '要重启 DSH 才会按新文件加载。') : null,
            ])
            : null,
          备份区(),
        ])
      }

      if (视图 === '表' && 表数据) return 表页()

      return h('div', { style: { padding: '12px 14px', fontSize: 13, lineHeight: 1.5, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } }, [
        h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } }, [
          h('div', { key: 't', style: { fontWeight: 600, fontSize: 14 } }, '会话瘦身'),
          h('div', { key: 'r', style: { display: 'flex', gap: 6 } }, [
            h('button', { key: 'h', style: 钮, onClick: () => 设帮开(true) }, '作者建议'),
            h('button', { key: 'f', style: 钮, onClick: 拉会话 }, '刷新'),
            h('button', { key: 'c', style: 钮, onClick: () => props.关?.() }, '关闭'),
          ]),
        ]),
        h('div', { key: 'need', style: { ...小字, marginBottom: 6, color: 色.警 } }, '本插件主要是为装了 billion-context 的 DSH 使用者做的；若未启用 billion-context，很多功能用不了。'),
        h('div', { key: 'd', style: { ...小字, marginBottom: 6 } }, '选会话 → 整理上下文构成，让那个会话自己列出占用表。折叠注入动手前自动备份，出问题在下面还原。'),
        h('div', { key: 'pcthelp', style: { ...小字, marginBottom: 8, userSelect: 'none' } },
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: 4 } }, "关于上下文百分比："),
          h('div', { key: 'x0', style: { marginBottom: 4 } }, "DSH 自己面板上那个百分比是「模型回报的上一次用量」，这里更准。"),
          h('div', { key: 'x1', style: { marginBottom: 4 } }, "对于bili-context压缩过的会话，删除整轮（包括转移）会导致无法与原有压缩账对应。不过只要会话未超窗，进行任意对话后就会重新压缩，没有太大影响。"),
          h('div', { key: 'x2', style: { marginBottom: 4 } }, "带「·压」表示这个数是bili-context压缩后的；带 ⚠ 表示压缩一旦失效，正文会超过 700K，有超窗风险。鼠标悬停在百分比上能看到详细信息。"),
          h('div', { key: 'x3', style: { marginBottom: 4 } }, "想处理带 ⚠ 的会话，可以看看右上角的“作者建议”。"),
        ),

        h('div', { key: 'list', style: { maxHeight: 220, overflowY: 'auto', border: `1px solid ${色.边框}`, borderRadius: 8 } }, 列表),
        错
          ? h('div', {
            key: 'e',
            style: {
              color: '#ffd7d7',
              background: '#3a1c20',
              border: '1px solid #a33b45',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.5,
              margin: '8px 0',
            },
          }, [
            h('div', { key: 'h', style: { fontWeight: 600, marginBottom: 2 } }, '没有执行'),
            h('div', { key: 'b' }, 错),
            注 ? h('div', { key: 'n', style: { marginTop: 6, color: '#ffc9c9' } }, '下一步：' + 注) : null,
            活着
              ? h('div', { key: 'f', style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } }, [
                h('button', {
                  key: 'b',
                  style: { ...钮, borderColor: 色.危, color: 色.危 },
                  onClick: () => {
                    设强制态(true)
                    设活着(false)
                    设错('')
                    设注('已允许强制清理：再点一次刚才那个操作，清完请立刻重启 DSH。')
                  },
                }, '仍然清理（清完必须重启）'),
                h('span', { key: 't', style: { ...小字, color: '#ffc9c9' } }, '点了它就直接改文件；改完务必重启，重启前不要在那个会话里说话'),
              ])
              : null,
          ])
          : null,
        当前项
          ? h('div', { key: 'pick', style: { marginTop: 8 } }, [
            h('div', { key: 'a', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
              h('span', { key: 'p', style: { ...小字 } }, `占用 ${当前项.占比 || 0}%（${((当前项.占用 || 0) / 1000).toFixed(0)}K / ${(窗口 / 1000).toFixed(0)}K）${当前项.账算 ? `，按压缩账算；按正文算是 ${((当前项.初算 || 0) / 1000).toFixed(0)}K` : '，按正文估算'}`),
            ]),
            超四成
              ? h('div', { key: 'w', style: { color: 色.警, fontSize: 12, marginTop: 4 } }, '上下文占用已可能导致注意力下降')
              : null,
            h('div', { key: 'ask', style: { marginTop: 8, padding: 10, border: `1px solid ${色.边框}`, borderRadius: 8, background: 色.选中 || 'transparent' } }, [
              h('button', {
                key: 'b',
                style: {
                  ...钮,
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '7px 14px',
                  borderColor: 问确认 ? 色.好 : 色.边框,
                  color: 问确认 ? 色.好 : 'inherit',
                },
                disabled: !!忙 || !当前,
                onClick: () => (问确认 ? 提问() : 设问确认(true)),
              }, 问确认 ? '确认投递？' : '整理上下文构成'),
              h('div', { key: 't', style: { ...小字, marginTop: 6, lineHeight: 1.5 } },
                '往这个会话尾部投一条提问。它会读自己的记录，按工作内容自己分行（工作内容 / 覆盖编号 / 建议），写进插件事先放好的那张表，这里读回来给你勾。'),
            ]),
            h('div', { key: 'old', style: { marginTop: 10, padding: 10, border: `1px solid ${色.边框}`, borderRadius: 8 } }, [
              h('div', { key: 'h', style: { fontSize: 12, fontWeight: 600 } },
                `清掉旧轮次（总共 ${当前项.轮数 || 0} 轮）`),
              h('div', { key: 'm', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } }, [
                h('span', { key: 'ml', style: 小字 }, '清什么'),
                ...[['tools', '工具结果'], ['memory', '折叠记忆'], ['move', '转移记录'], ['drop', '整轮删除']].map(([键, 名]) => h('button', {
                  key: 键,
                  style: {
                    ...钮,
                    padding: '3px 10px',
                    fontSize: 12,
                    borderColor: 清旧模式 === 键 ? 色.主 : 色.边框,
                    color: 清旧模式 === 键 ? 色.主 : 'inherit',
                    fontWeight: 清旧模式 === 键 ? 600 : 400,
                  },
                  disabled: !!忙,
                  onClick: () => { 设清旧模式(键); 设清确认(false) },
                }, 名)),
              ]),
              h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } }, [
                h('span', { key: 'l', style: 小字 }, '保留最近'),
                h('input', {
                  key: 'i',
                  type: 'number',
                  min: 0,
                  max: 当前项.轮数 || 9999,
                  value: 保留轮数,
                  style: { ...小字, width: 64, padding: '3px 6px', background: 'transparent', color: 'inherit', border: `1px solid ${色.边框}`, borderRadius: 6 },
                  onChange: (e) => 设保留轮数(e.target.value),
                }),
                h('span', { key: 'l2', style: 小字 }, '轮'),
                h('button', {
                  key: 'b',
                  style: { ...钮, marginLeft: 'auto', borderColor: 清确认 ? 色.危 : 色.边框, color: 清确认 ? 色.危 : 'inherit' },
                  disabled: !!忙 || !当前,
                  onClick: () => (清确认 ? 清旧轮() : 设清确认(true)),
                }, 清确认
                  ? `${清旧模式 === 'memory' ? '确认换成记忆' : 清旧模式 === 'move' ? '确认搬走' : '确认清掉'}前 ${Math.max(0, (当前项.轮数 || 0) - (Number(保留轮数) || 0))} 轮？`
                  : '清除'),
              ]),
              h('div', { key: 't', style: { ...小字, marginTop: 4 } },
                清旧模式 === 'drop'
                  ? '更早的轮次整段删掉（连轮/步骨架一起），删完轮数就真的变成保留的那几轮；这些轮不会再出现在会话里，也回溯不到。'
                  : 清旧模式 === 'memory'
                    ? '更早的轮次整段删掉，换成 billion-context 账里的压缩记忆（一句话一段，带正文），再接上保留的这几轮——像「记忆版」那样。没有压缩账的会话用不了这个。'
                    : 清旧模式 === 'move'
                      ? '更早的轮次先搬进一条新会话（名字叫「原会话·旧记录」），确认那条能打开，再从这条里删掉。想留住对话又嫌占上下文，用这个。'
                      : '更早轮次的工具结果正文换成「（工具结果已清除）」，对话和工具调用本身保留，轮数不变。'),
              h('div', { key: 't2', style: { ...小字, marginTop: 4 } },
                当前项.折叠账
                  ? '这条会话有 billion-context 的压缩账：清理后我会把账本一起备份并清掉，让它按新文件从零折叠（否则账会悬空、整本作废）。'
                  : '这条会话没有 billion-context 折叠账（不影响聊天，DSH 自己的上下文压缩还在）；清理只动文件，不涉及它。'),
            ]),
            备份区(),
          ])
          : h('div', { key: 'pick0', style: { ...小字, marginTop: 8 } }, '还没选会话'),
        忙 ? h('div', { key: 'w2', style: { ...小字, marginTop: 6 } }, `${忙}… ${等秒 ? 等秒 + ' 秒' : ''}${忙 === '投提问' ? '（那个会话正在跑，等它说完）' : ''}`) : null,
        注入区(),
        结果
          ? h('div', { key: 'ok', style: { marginTop: 10, border: `1px solid ${色.边框}`, borderRadius: 8, padding: 8, fontSize: 12 } }, [
            h('div', { key: 'a' }, 结果.提问
              ? (结果.提问.文本
                ? '它整理出来的构成：'
                : 结果.提问.超时
                  ? '投过去了，但没等到回话（会话可能正忙）。'
                  : '已投递。去那个会话里回一句，它就会把构成表整理出来。')
              : 结果.复制
              ? `已复制成新会话「${结果.复制}」${结果.事件 ? `（${结果.事件} 条事件）` : ''}。这条会话一个字没动，不用重启。`
              : 结果.还原
              ? `已还原：${结果.还原}`
              : 结果.清旧
                ? 结果.清旧.模式 === 'move'
                  ? `搬走了前 ${结果.清旧.转移轮} 轮，建了新会话「${结果.清旧.新会话}」（${结果.清旧.新事件} 条事件、${结果.清旧.新大小}）；这条现在剩 ${结果.清旧.剩余事件} 条事件`
                  : 结果.清旧.模式 === 'memory'
                  ? `换成了 ${结果.清旧.记忆块} 段压缩记忆，替掉前 ${结果.清旧.替换轮} 轮，保留最近 ${结果.清旧.保留轮} 轮；现在 ${结果.清旧.事件} 条事件、${(结果.清旧.字节 / 1048576).toFixed(2)}MB`
                  : 结果.清旧.模式 === 'drop'
                  ? `整段删掉了前 ${结果.清旧.清了轮} 轮，现在只剩 ${结果.清旧.保留轮} 轮；剩 ${结果.清旧.剩余事件} 条事件、${(结果.清旧.新字节 / 1048576).toFixed(2)}MB（原 ${(结果.清旧.原字节 / 1048576).toFixed(2)}MB）`
                  : `清掉了前 ${结果.清旧.清了轮} 轮的工具结果，保留最近 ${结果.清旧.保留轮} 轮（轮数不变）；剩 ${结果.清旧.剩余事件} 条事件、${(结果.清旧.新字节 / 1048576).toFixed(2)}MB（原 ${(结果.清旧.原字节 / 1048576).toFixed(2)}MB）`
              : 结果.折叠
                ? `已折叠 ${结果.折叠} 处重复注入，省 ${(结果.省字 / 1000).toFixed(0)}k 字`
                : `${结果.模式 === 'tools' ? '已清工具结果' : '已清对话和工具结果'}，剩 ${结果.剩余事件} 条事件、${(结果.新字节 / 1048576).toFixed(2)}MB`),
            结果.提问 && 结果.提问.表 && 结果.提问.表.length
              ? 构成表(结果.提问)
              : 结果.提问 && 结果.提问.文本
                ? h('pre', { key: 'p', style: { ...小字, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.55, maxHeight: 420, overflowY: 'auto' } }, 结果.提问.文本)
                : null,
            h('div', { key: 'b', style: 小字 }, 结果.备份 ? `备份：${结果.备份}` : ''),
            结果.备份 ? h('div', { key: 'c', style: { ...小字, marginTop: 4 } }, '要重启 DSH 才会按新文件加载。') : null,
          ])
          : null,
        提醒重启 ? 重启弹窗(() => 设提醒重启(false), 动作名) : null,
      帮开 ? 帮助弹窗({ 关: () => 设帮开(false), 文: 帮文, 设文: 设帮文, 存: 存帮, 复: 复帮 }) : null,
      ])
    }

    // 任何清除/折叠/还原之后都要先重启宿主，否则它会把内存里的旧记录写回去
    // 帮助弹窗：正文可编辑，保存到服务端（数据根/help.md），清空即恢复出厂正文
    function 帮助弹窗({ 关, 文, 设文, 存, 复 }) {
      const 卡 = { maxWidth: 620, width: '100%', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: '#1b1b1f', color: '#eee', border: `1px solid ${色.边框}`, borderRadius: 12, padding: '16px 16px 12px', boxShadow: '0 12px 40px rgba(0,0,0,.5)', fontSize: 13, lineHeight: 1.6 }
      const 罩 = { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
      return h('div', { key: 'help-mask', style: 罩 },
        h('div', { style: 卡 }, [
          h('div', { key: 't', style: { fontWeight: 600, fontSize: 14, marginBottom: 8 } }, '作者建议（可直接改，保存后一直生效）'),
          h('textarea', {
            key: 'e',
            value: 文,
            spellCheck: false,
            onChange: (e) => 设文(e.target.value),
            style: {
              flex: 1,
              minHeight: 320,
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              background: 'rgba(255,255,255,0.04)',
              color: 'inherit',
              border: `1px solid ${色.边框}`,
              borderRadius: 8,
              padding: 10,
              fontSize: 12.5,
              lineHeight: 1.65,
              fontFamily: 'inherit',
              whiteSpace: 'pre-wrap',
            },
          }),
          h('div', { key: 'h', style: { ...小字, marginTop: 6 } }, '空行会原样保留。点「恢复出厂」会丢掉你改的内容。'),
          h('div', { key: 'a', style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } }, [
            h('button', { key: 'r', style: { ...钮, borderColor: 色.边框 }, onClick: 复 }, '恢复出厂'),
            h('button', { key: 'c', style: { ...钮, borderColor: 色.边框 }, onClick: 关 }, '关闭'),
            h('button', { key: 's', style: { ...钮, borderColor: 色.好, color: 色.好, padding: '5px 18px' }, onClick: 存 }, '保存'),
          ]),
        ]))
    }

    function 重启弹窗(关, 做了什么 = '这次操作') {

      const 卡 = { maxWidth: 420, width: '100%', background: '#1b1b1f', color: '#eee', border: `1px solid ${色.边框}`, borderRadius: 12, padding: '18px 18px 14px', boxShadow: '0 12px 40px rgba(0,0,0,.5)', fontSize: 13, lineHeight: 1.6 }
      const 罩 = { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
      return h('div', { key: 'restart-mask', style: 罩 },
        h('div', { style: 卡 }, [
          h('div', { key: 't', style: { fontWeight: 600, fontSize: 14, marginBottom: 6 } }, `${做了什么}完成，请先重启 DeepSeek Harness`),
          h('div', { key: 'b' }, '文件已经改好了，但宿主内存里还是旧的。请务必先重启 DeepSeek Harness，再打开这个会话——否则它会拿旧记录覆盖掉刚改好的文件，可能把会话写坏。'),
          h('div', { key: 'a', style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
            h('button', { style: { ...钮, borderColor: 色.边框, padding: '5px 14px' }, onClick: 关 }, '稍后'),
            h('button', { style: { ...钮, borderColor: 色.好, color: 色.好, padding: '5px 18px' }, onClick: 关 }, '知道了，去重启')),
          h('div', { key: 'v', style: { ...小字, marginTop: 8, textAlign: 'right' } }, '面板版本 cc4'),
        ]))
    }

    // 图标跟宿主其他插件一致：单色线条，颜色随父级 currentColor，16px
    function 扫帚图标() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      }, [
        // 杆
        h('path', { key: 'a', d: 'M12 2.5v7' }),
        // 箍
        h('path', { key: 'b', d: 'M9.4 9.5h5.2' }),
        h('path', { key: 'c', d: 'M9.8 11.2h4.4' }),
        // 帚头（上窄下宽的梯形）
        h('path', { key: 'd', d: 'M9.8 11.9h4.4l1.7 7.2a1.1 1.1 0 0 1-1.1 1.4H9.2a1.1 1.1 0 0 1-1.1-1.4Z' }),
        // 几根 bristle 线，让它一眼是扫帚而不是三角形
        h('path', { key: 'e', d: 'M11 13.6v6.4' }),
        h('path', { key: 'f', d: 'M13 13.6v6.4' }),
      ])
    }

    function 入口行(props) {
      return h('span', {
        'data-dsh-plugin': 'dsh-selective-trim',
        'data-dsh-part': 'sidebar-icon',
        title: '会话瘦身',
        onClick: () => props?.开?.(),
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, lineHeight: 0, color: 'inherit' },
      }, 扫帚图标())
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const 面板ID = 'selective-trim'
        const 开 = () => {
          try { ctx.layout?.selectPanel(面板ID) } catch {}
        }
        const 关 = () => {
          try { ctx.layout?.selectPanel(null) } catch {}
        }
        try {
          ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
            const 停主 = ctx.slots.register({ name: 'main', key: 面板ID, inject: () => ({ 关 }) }, (props) => h(兜底, null, h(工作台, props)))
            const 停行 = ctx.slots.register({ name: 'sidebar.panellist', id: 面板ID, order: 32, label: () => '会话瘦身' }, (props) => 入口行({ ...props, 开, 关 }))
            return () => {
              停行()
              停主()
            }
          }))
        } catch {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 面板ID, order: 32, label: () => '会话瘦身' }, (props) => h(兜底, null, h(工作台, { ...props, 关 }))))
        }
      },
    }
  },
})
