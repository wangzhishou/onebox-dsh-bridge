// 配对轮询的指数退避策略(独立成模块便于 node:test 纯逻辑单测,不引依赖)。
//
// 背景: 旧版 (≤0.2.0) 以固定 2s 间隔轮询 pair-sessions status, 常驻插件使它
// 成为网关最高频路由; Redis 按命令计费的部署里这是主要成本。改为 1s 起步、
// 翻倍、上限 30s 的指数退避, 并采纳服务端 429 的 Retry-After 头。

export const PAIR_POLL_MIN_MS = 1_000
export const PAIR_POLL_MAX_MS = 30_000

/**
 * 计算下一次轮询间隔。
 * @param {number} currentMs 当前间隔
 * @param {number} [retryAfterSec] 服务端 429 的 Retry-After 秒数 (0/缺省 = 无)
 * @returns {number} 下一次间隔毫秒: 正常翻倍封顶 30s; 有 Retry-After 时取两者较大值,
 *                   且服务端建议不受 30s 上限约束 (服务端比我们更知道该慢多少)。
 */
export function nextPairPollMs(currentMs, retryAfterSec = 0) {
  const doubled = Math.min(currentMs * 2, PAIR_POLL_MAX_MS)
  if (retryAfterSec > 0) {
    return Math.max(doubled, retryAfterSec * 1000)
  }
  return doubled
}
