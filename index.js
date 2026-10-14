// onebox-dsh-bridge — 万宝盒云端中继桥插件。
// 形态: dsh 组合包(bundle),在 dsh web 上挂 /onebox-bridge 页面(QR + 状态),
// 后台跑扫码配对 → 取回设备 token → 出站 WSS 控制隧道 的状态机。
// 配对/隧道契约与 strapi_go /dsh 路由及 Go 版 dsh-connector 一致,见 lib/tunnel.js 头注释。
// E2E: 配对时生成 32 字节密钥经 QR k 参数下发,隧道内 http body / ws 帧 AES-256-GCM 加密,见 lib/e2e.js。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import QRCode from 'qrcode'
import { PAIR_POLL_MIN_MS, nextPairPollMs } from './lib/backoff.js'
import { createCipher } from './lib/e2e.js'
import { createSessionCookie } from './lib/session-cookie.js'
import { Tunnel } from './lib/tunnel.js'
import { renderPage } from './lib/page.js'

export const name = 'onebox-dsh-bridge'
export const inject = ['webServer']

// 万宝盒两套部署:国内(VPS)与海外(Cloud Run)。App 的登录 JWT 只在所属部署有效,
// 所以默认同时对两边各建一个配对会话、各出一张二维码;哪张先被认领,隧道就建到哪边。
const DEFAULT_GATEWAYS = ['https://api.wanbaohe.com', 'https://api.oneboxable.com']
const DEFAULT_UPSTREAM = '127.0.0.1:3080'
const PAIR_RETRY_MS = 3_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ gateway?: string, gateways?: string[], upstream?: string, deviceName?: string, dataDir?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const gateways = resolveGateways(config)
  const upstream = process.env.ONEBOX_DSH_UPSTREAM || config.upstream || DEFAULT_UPSTREAM
  const deviceName = config.deviceName || os.hostname()
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = process.env.ONEBOX_DSH_DATA_DIR || config.dataDir
    || path.join(dshHome, 'profiles', 'web', 'onebox-dsh-bridge')
  const tokenPath = path.join(dataDir, 'token.json')

  const log = (msg) => ctx.logger.info(`[onebox-dsh-bridge] ${msg}`)
  const warn = (msg) => ctx.logger.warn(`[onebox-dsh-bridge] ${msg}`)

  /**
   * 页面轮询用的只读状态。phase: boot|pairing|connecting|online|offline。
   * pairs 仅 pairing 阶段有内容,每个网关一项:
   * { gateway, kind, qrSvg, payload, expiresAt, detail }。
   */
  const state = { phase: 'boot', deviceId: '', gateway: '', detail: '', e2e: false, pairs: [] }

  let stopped = false
  /** 代次计数:+1 即让所有配对循环废弃当前会话重新生成(重新生成按钮/410 过期/分出胜负)。 */
  let pairGen = 0
  /** @type {Tunnel | null} 当前控制隧道,解绑时主动关闭。 */
  let currentTunnel = null
  const timers = new Set()

  /**
   * 本机 dsh 的浏览器会话 cookie(0.1.5 起 /api 必需,loopback 也一样)。
   * connection 服务可能晚于本插件装载,所以用原地注入:拿到之前隧道按无 cookie 走,
   * 拿到之后所有请求自动带上;旧版 dsh 不需要 cookie,拿不到也不影响。
   */
  let sessionCookie = null
  ctx.inject(['connection'], (connectionCtx) => {
    sessionCookie = createSessionCookie({
      connection: connectionCtx.connection,
      upstream,
      log: (msg) => warn(msg),
    })
    log('已接入 connection:隧道请求将携带 dsh web 会话 cookie')
  })

  // ---------- 凭据持久化 ----------

  function loadToken() {
    try {
      const cred = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      // token 与网关绑定;凭据的网关不在当前配置里即不可用
      if (cred.token && gateways.includes(cred.gateway)) return cred
    } catch { /* 不存在或损坏按未配对处理 */ }
    return null
  }

  function saveToken(cred) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenPath, JSON.stringify(cred, null, 2), { mode: 0o600 })
  }

  function removeToken() {
    try { fs.unlinkSync(tokenPath) } catch { /* 本来就不存在 */ }
  }

  // ---------- 网关配对 API ----------

  async function createPairSession(gateway) {
    const resp = await fetch(`${gateway}/dsh/pair-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) throw new Error(`建配对会话失败 HTTP ${resp.status}`)
    const data = await resp.json()
    if (!data.pairingId) throw new Error('配对会话响应缺少 pairingId')
    return data // { pairingId, expiresIn }
  }

  /** @returns {Promise<{status:string, token?:string, deviceId?:string, retryAfter?:number} | 'gone'>} */
  async function pollPairStatus(gateway, pairingId, secret) {
    const resp = await fetch(
      `${gateway}/dsh/pair-sessions/${encodeURIComponent(pairingId)}/status?s=${encodeURIComponent(secret)}`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (resp.status === 410) return 'gone'
    // 服务端每 IP 限流 (1 r/s): 采纳 Retry-After, 由调用方加大轮询间隔
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('retry-after')) || 0
      return { status: 'rate_limited', retryAfter }
    }
    if (!resp.ok) throw new Error(`查询配对状态失败 HTTP ${resp.status}`)
    return resp.json()
  }

  // ---------- 状态机主循环 ----------

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { timers.delete(t); resolve() }, ms)
      timers.add(t)
    })
  }

  /** 配对:每个网关各建会话、各出 QR、2s 轮询;先被认领的胜出,落盘返回凭据。 */
  async function pair() {
    while (!stopped) {
      const gen = pairGen
      state.phase = 'pairing'
      state.deviceId = ''
      state.gateway = ''
      state.detail = ''
      state.pairs = gateways.map((gateway) => ({
        gateway, kind: gatewayKind(gateway), qrSvg: '', payload: '', expiresAt: 0, detail: '',
      }))
      const cred = await racePairSessions(gen)
      if (cred) return cred
      // 全灭:代次被改(重新生成按钮)或正在停止;回到 while 重建全部会话
    }
    return null
  }

  /** 全部网关的配对循环并发开跑;先认领的凭据胜出,代次失效全灭时返回 null。 */
  function racePairSessions(gen) {
    return new Promise((resolve) => {
      let pending = state.pairs.length
      let winner = null
      const settle = (cred) => {
        if (cred && !winner) winner = cred
        if (--pending === 0) resolve(winner)
      }
      for (const entry of state.pairs) {
        pairGateway(entry, gen).then(settle)
      }
    })
  }

  /** 单网关配对循环:claimed 返回凭据;410/建会话失败就地重建;代次失效或停止返回 null。 */
  async function pairGateway(entry, gen) {
    const gateway = entry.gateway
    while (!stopped && gen === pairGen) {
      let sess
      try {
        sess = await createPairSession(gateway)
      } catch (err) {
        entry.qrSvg = ''
        entry.payload = ''
        entry.detail = `网关不可达:${errMsg(err)},${PAIR_RETRY_MS / 1000} 秒后重试`
        warn(`[${gateway}] ${entry.detail}`)
        await sleep(PAIR_RETRY_MS)
        continue
      }
      // ≥128bit secret,base64url 编码进 QR;e2eKey 为 32 字节 E2E 密钥,k 参数下发(直接作 AES-256-GCM 密钥)
      const secret = crypto.randomBytes(32).toString('base64url')
      const e2eKey = crypto.randomBytes(32).toString('base64url')
      const qrText = `oneboxdsh://pair?v=1&g=${gateway}&p=${sess.pairingId}&s=${secret}&k=${e2eKey}`
      entry.qrSvg = await QRCode.toString(qrText, { type: 'svg', margin: 1 })
      entry.payload = qrText // 原始配对链接(供复制/调试用,仅 loopback 页面可见)
      entry.expiresAt = Date.now() + (sess.expiresIn || 300) * 1000
      entry.detail = ''
      log(`[${gateway}] 配对会话 ${sess.pairingId} 已创建,等待扫码`)

      // 轮询间隔: 新会话从 1s 起步 (扫码响应快), pending 后指数退避, 上限 30s
      let pollMs = PAIR_POLL_MIN_MS
      while (!stopped && gen === pairGen) {
        await sleep(pollMs)
        if (stopped || gen !== pairGen) return null
        let result
        try {
          result = await pollPairStatus(gateway, sess.pairingId, secret)
        } catch (err) {
          entry.detail = `轮询失败:${errMsg(err)}`
          continue // 网络抖动不重建会话,间隔不变,下轮再试
        }
        if (result === 'gone') {
          log(`[${gateway}] 配对会话已过期,重新生成`)
          break
        }
        if (result.status === 'rate_limited') {
          // 服务端 429: 采纳 Retry-After 并继续退避
          pollMs = nextPairPollMs(pollMs, result.retryAfter || 0)
          entry.detail = `网关限流,轮询间隔已升至 ${Math.round(pollMs / 1000)}s`
          continue
        }
        if (result.status === 'claimed' && result.token) {
          const cred = { token: result.token, deviceId: result.deviceId || '', e2eKey, gateway }
          try {
            saveToken(cred)
          } catch (err) {
            warn(`写入 token 失败:${errMsg(err)}`)
          }
          log(`[${gateway}] 配对成功,设备 ${cred.deviceId}`)
          pairGen++ // 让其它网关的配对循环退出
          state.pairs = []
          return cred
        }
        // 仍是 pending: 退避翻倍
        pollMs = nextPairPollMs(pollMs)
        entry.detail = pollMs > PAIR_POLL_MIN_MS
          ? `等待扫码中(轮询间隔 ${Math.round(pollMs / 1000)}s)`
          : ''
      }
    }
    return null
  }

  /** 一条控制隧道会话;resolve 'unauthorized'(回配对)或 'dropped'(退避重连)。 */
  function session(cred) {
    return new Promise((resolve) => {
      state.phase = 'connecting'
      state.deviceId = cred.deviceId
      state.gateway = cred.gateway
      // 旧凭据(无 e2eKey)= 明文隧道;key 损坏按明文降级,不阻断连接
      let cipher = null
      if (cred.e2eKey) {
        try {
          cipher = createCipher(cred.e2eKey)
        } catch (err) {
          warn(`E2E 密钥无效,回退明文:${errMsg(err)}`)
        }
      }
      const url = `${wsBase(cred.gateway)}/dsh/agent?token=${encodeURIComponent(cred.token)}`
      const tunnel = new Tunnel({
        url,
        upstream,
        cipher,
        cookieProvider: () => sessionCookie,
        log,
        onOpen: () => {
          state.phase = 'online'
          state.detail = ''
          state.deviceId = cred.deviceId
        },
        onClose: (result) => {
          currentTunnel = null
          resolve(result)
        },
      })
      currentTunnel = tunnel
      tunnel.connect()
    })
  }

  async function run() {
    let backoff = RECONNECT_MIN_MS
    while (!stopped) {
      let cred = loadToken()
      if (!cred) {
        cred = await pair()
        if (!cred) return
        backoff = RECONNECT_MIN_MS
      }
      state.e2e = Boolean(cred.e2eKey)
      const result = await session(cred)
      if (stopped) return
      if (result === 'unauthorized') {
        warn('设备 token 已失效或被吊销,回到扫码配对')
        removeToken()
        state.e2e = false
        state.gateway = ''
        state.detail = '设备已解绑,请重新扫码配对'
        backoff = RECONNECT_MIN_MS
        continue
      }
      state.phase = 'offline'
      state.detail = `连接断开,${backoff / 1000} 秒后重连`
      log(state.detail)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  // ---------- GUI / 状态路由 ----------

  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  function handler(req, res) {
    const pathname = new URL(req.url || '/', 'http://x').pathname
    if (req.method === 'GET' && (pathname === '/onebox-bridge' || pathname === '/onebox-bridge/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderPage())
      return
    }
    if (req.method === 'GET' && pathname === '/onebox-bridge/api/status') {
      json(res, 200, {
        phase: state.phase,
        deviceId: state.deviceId,
        detail: state.detail,
        gateway: state.gateway, // 当前已连接/连接中的网关;配对阶段为空
        pairs: state.pairs, // 配对阶段的各网关二维码与状态
        upstream,
        e2e: state.e2e, // 当前凭据是否携带 E2E 密钥
        // dsh 0.1.5 起隧道请求要带本机会话 cookie;false 说明 connection 服务还没接入
        authCookie: sessionCookie !== null,
      })
      return
    }
    if (req.method === 'POST' && pathname === '/onebox-bridge/api/regenerate') {
      pairGen++ // 配对循环下一轮即废弃旧会话重建;在线时无效果(不影响隧道)
      if (state.phase === 'pairing') state.detail = '正在重新生成二维码…'
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && pathname === '/onebox-bridge/api/unbind') {
      removeToken()
      pairGen++ // 若正在配对,顺便换一张新 QR
      // 以 unauthorized 收场,主循环直接回配对态(不退避)
      currentTunnel?.close('unauthorized')
      json(res, 200, { ok: true })
      return
    }
    json(res, 404, { error: 'not found' })
  }

  // ---------- 挂载与清理 ----------

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/onebox-bridge', handler }))
  ctx.effect(() => {
    run().catch((err) => warn(`状态机异常退出:${errMsg(err)}`))
    log(`已加载,页面 http://${ctx.webServer.host}:${ctx.webServer.port}/onebox-bridge,网关:${gateways.join(', ')}`)
    return () => {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
      currentTunnel?.close('dropped')
    }
  })
}

/**
 * 网关列表解析:ONEBOX_DSH_GATEWAYS(逗号分隔)> config.gateways
 * > ONEBOX_DSH_GATEWAY / config.gateway(单值,等价于单元素数组)> 默认双部署。
 * @param {{ gateway?: string, gateways?: string[] }} config
 * @returns {string[]} 去尾斜杠、去重、非空
 */
function resolveGateways(config) {
  const envList = process.env.ONEBOX_DSH_GATEWAYS
  const envSingle = process.env.ONEBOX_DSH_GATEWAY
  let list
  if (envList) list = envList.split(',')
  else if (envSingle) list = [envSingle]
  else if (Array.isArray(config.gateways) && config.gateways.length) list = config.gateways
  else if (config.gateway) list = [config.gateway]
  else list = DEFAULT_GATEWAYS
  return [...new Set(list.map((g) => trimSlash(String(g).trim())).filter(Boolean))]
}

/** 网关归类(页面标注用):domestic=国内版 App,overseas=海外版 App,custom=自建。 */
function gatewayKind(gateway) {
  if (gateway.includes('wanbaohe.com')) return 'domestic'
  if (gateway.includes('oneboxable.com')) return 'overseas'
  return 'custom'
}

function trimSlash(s) {
  return s.replace(/\/+$/, '')
}

function wsBase(gateway) {
  return gateway.replace(/^http/, 'ws')
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
