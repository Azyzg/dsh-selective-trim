// dsh-selective-trim 入口：注册 Web 路由与 ctx_dedupe 工具，具体实现在 lib/ 下
import { 记, 状态 } from './lib/base.mjs'
import { 处理请求, 注册去重工具, 试清除 } from './lib/api.mjs'
import * as base from './lib/base.mjs'
import * as io from './lib/io.mjs'
import * as sessions from './lib/sessions.mjs'
import * as analysis from './lib/analysis.mjs'
import * as ledger from './lib/ledger.mjs'
import * as inj from './lib/inject.mjs'
import * as backup from './lib/backup.mjs'
import * as table from './lib/table.mjs'
import * as clean from './lib/clean.mjs'
import * as ops from './lib/ops.mjs'
import * as transfer from './lib/transfer.mjs'

export const name = 'selective-trim'
export const inject = ['webServer', 'sessions', 'tools']
export { 设保留份数 } from './lib/inject.mjs'

export function apply(ctx) {
  记('apply 被调用')
  状态.宿主ctx = ctx
  状态.会话控 = ctx.get('sessionController') ?? null
  状态.会话API = ctx.get('sessions') ?? null
  记(`sessionController: ${状态.会话控 ? '有' : '没有'} / sessions: ${状态.会话API ? '有' : '没有'}`)

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'prefix', path: '/dsh-selective-trim', handler: 处理请求 }),
  )
  try {
    注册去重工具(ctx)
  } catch (e) {
    记(`注册 ctx_dedupe 出错：${String(e && e.message)}`)
  }
}

const 摘 = (模, 名们) => Object.fromEntries(名们.map((n) => [n, 模[n]]))

// 离线调试用：node --input-type=module -e "import('./index.js').then(m => m.__test.列会话())"
export const __test = {
  ...摘(io, ['读会话', '写会话', '校验', '宿主校验']),
  ...摘(sessions, ['列会话', '读首句', '读标题']),
  ...摘(analysis, ['分析文件', '分段', '读轮数', '读占用']),
  ...摘(ledger, ['过闸', '估体tokens', '有折叠账', '账在用的tokens', '取压缩记忆']),
  ...摘(inj, ['统计注入', '折叠注入']),
  ...摘(backup, ['列备份', '还原', '正在用', '挡活会话', '标待重启', '读待重启']),
  ...摘(table, ['构提问', '写表模板', '解析表文件', '表文件']),
  ...摘(clean, ['重建', '重编轮步', '执行清除区间', '执行去重']),
  ...摘(ops, ['执行清旧轮', '执行记忆替换', '执行记忆区间']),
  ...摘(transfer, ['执行转移记录', '执行转移区间', '执行复制区间', '建新会话']),
  ...摘(base, ['用户话']),
  试清除,
}
