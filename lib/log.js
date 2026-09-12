// 日志去重:同一条提示只打一次(避免每字节流量刷屏)。
const seen = new Set()

/**
 * 同 key 只输出一次。
 * @param {(msg: string) => void} log
 * @param {string} msg
 */
export function warn(log, msg) {
  if (seen.has(msg)) return
  seen.add(msg)
  log(msg)
}
