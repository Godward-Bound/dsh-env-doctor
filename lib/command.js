import { serviceOf } from './shared.js'

/** /env 斜杠命令：宿主侧直接执行，不产生模型消息、不烧 token。
 *  拿不到 commands 服务就安静跳过（headless / 老宿主），只记一行日志——
 *  不要把 'commands' 写进 inject 数组，那会让 headless 环境整棵树挂。
 *  runEnvironmentReport 由 index.js 传入（绑定好 cfg 的版本）：
 *  工具与命令共用同一条实现路径（one operation, two callers）。 */
export function registerEnvCommand(ctx, { runEnvironmentReport, log } = {}) {
  const commands = serviceOf(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') {
    log?.('没注册命令：宿主没有 commands 服务')
    return null
  }
  return commands.register({
    name: 'env',
    description: '查这台机器：常驻端口、磁盘剩余、DSH 快照占用、本会话 token',
    input: { hint: '[ports|disk|session|all]' },
    handler(invocation) {
      const what = String(invocation?.rawInput ?? '').trim().toLowerCase() || 'all'
      if (!['ports', 'disk', 'session', 'all'].includes(what)) {
        return { kind: 'error', text: '用法：/env [ports|disk|session|all]' }
      }
      return Promise.resolve()
        .then(() => runEnvironmentReport(what))
        .then((r) => ({ kind: 'success', text: r.report }))
        .catch((e) => ({ kind: 'error', text: `/env 出错：${String(e?.message ?? e)}` }))
    },
  })
}
