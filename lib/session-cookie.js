// 本机 dsh web 的浏览器会话 cookie 提供者。
//
// 为什么需要:DSH 0.1.5 起,/api 的**每一个**请求(含 /api/remote.mux 的 WebSocket 升级)
// 都要过 connection.requestRejection 的浏览器鉴权——loopback 也不例外:
// 没有浏览器 cookie 一律 401 'unauthorized',`Authorization: Bearer …` 不被识别,
// `--trusted-host` 只放宽 Host 围栏(403)不解决鉴权。
//
// 插件本身跑在 dsh web 进程里,所以能拿到"带进程令牌的入口 URL"
// (ctx.connection.authenticatedUrl),用它换一次 Set-Cookie 并缓存:
//   GET http://<upstream>/?token=<进程令牌>  →  303 + Set-Cookie: <authority 绑定签名 cookie>
// 之后所有隧道请求(HTTP 与 WS 升级)带上该 Cookie 即与浏览器等价。
//
// cookie 由持久 secret 签名(默认 30 天有效),进程重启后仍可用;401 时丢弃重取。

import { warn as warnOnce } from './log.js'

/** 默认缓存时长:取不到 Max-Age 时用它(cookie 实际 30 天,提前重取更安全) */
const FALLBACK_TTL_MS = 60 * 60 * 1000

/**
 * @param {object} options
 * @param {any} options.connection - dsh 的 connection 服务(提供 authenticatedUrl)
 * @param {string} options.upstream - 本机 dsh 地址,如 127.0.0.1:3080
 * @param {(msg: string) => void} [options.log]
 * @returns {{ header: () => Promise<string | null>, invalidate: () => void }}
 */
export function createSessionCookie({ connection, upstream, log = () => {} }) {
  /** @type {{ header: string, expiresAt: number } | null} */
  let cached = null
  /** @type {Promise<{ header: string, expiresAt: number } | null> | null} */
  let inflight = null

  function authenticatedUrl() {
    if (typeof connection?.authenticatedUrl !== 'function') return null
    try {
      return connection.authenticatedUrl(`http://${upstream}`)
    } catch {
      return null
    }
  }

  /** 解析 Set-Cookie 的 Max-Age,推算出保守的缓存到期时间 */
  function expiryOf(setCookies) {
    for (const raw of setCookies) {
      const match = /(?:^|;)\s*max-age=(\d+)/i.exec(raw)
      if (match) {
        // 提前 20% 失效,避免边界上刚好过期
        const ms = Number(match[1]) * 1000
        if (Number.isFinite(ms) && ms > 0) return Date.now() + Math.floor(ms * 0.8)
      }
    }
    return Date.now() + FALLBACK_TTL_MS
  }

  async function mint() {
    const url = authenticatedUrl()
    if (url === null) return null
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const pairs = setCookies.map((c) => c.split(';')[0]).filter(Boolean)
    if (pairs.length === 0) {
      warnOnce(log, `换取 dsh web cookie 失败:HTTP ${res.status} 未返回 Set-Cookie`)
      return null
    }
    return { header: pairs.join('; '), expiresAt: expiryOf(setCookies) }
  }

  return {
    /** 取当前可用的 Cookie 头;拿不到(旧版 dsh / 服务缺失)返回 null,调用方按无 cookie 继续 */
    async header() {
      if (cached && cached.expiresAt > Date.now()) return cached.header
      if (inflight) {
        const shared = await inflight
        return shared?.header ?? null
      }
      inflight = mint()
        .then((fresh) => {
          cached = fresh
          return fresh
        })
        .catch((err) => {
          warnOnce(log, `换取 dsh web cookie 异常:${err instanceof Error ? err.message : String(err)}`)
          cached = null
          return null
        })
        .finally(() => {
          inflight = null
        })
      const result = await inflight
      return result?.header ?? null
    },

    /** 401 后丢弃缓存,下一次 header() 重新换取 */
    invalidate() {
      cached = null
    },
  }
}
