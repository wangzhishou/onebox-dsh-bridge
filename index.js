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
import { createCipher } from './lib/e2e.js'
import { Tunnel } from './lib/tunnel.js'
import { renderPage } from './lib/page.js'

export const name = 'onebox-dsh-bridge'
export const inject = ['webServer']

const DEFAULT_GATEWAY = 'https://api.wanbaohe.com'
const DEFAULT_UPSTREAM = '127.0.0.1:3080'
const PAIR_POLL_MS = 2_000
const PAIR_RETRY_MS = 3_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ gateway?: string, upstream?: string, deviceName?: string, dataDir?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const gateway = trimSlash(process.env.ONEBOX_DSH_GATEWAY || config.gateway || DEFAULT_GATEWAY)
  const upstream = process.env.ONEBOX_DSH_UPSTREAM || config.upstream || DEFAULT_UPSTREAM
  const deviceName = config.deviceName || os.hostname()
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = process.env.ONEBOX_DSH_DATA_DIR || config.dataDir
    || path.join(dshHome, 'profiles', 'web', 'onebox-dsh-bridge')
  const tokenPath = path.join(dataDir, 'token.json')

  const log = (msg) => ctx.logger.info(`[onebox-dsh-bridge] ${msg}`)
  const warn = (msg) => ctx.logger.warn(`[onebox-dsh-bridge] ${msg}`)

  /** 页面轮询用的只读状态。phase: boot|pairing|connecting|online|offline */
  const state = { phase: 'boot', deviceId: '', qrSvg: '', payload: '', expiresAt: 0, detail: '', e2e: false }

  let stopped = false
  /** 代次计数:+1 即让配对循环废弃当前会话重新生成(重新生成按钮/410 过期)。 */
  let pairGen = 0
  /** @type {Tunnel | null} 当前控制隧道,解绑时主动关闭。 */
  let currentTunnel = null
  const timers = new Set()

  // ---------- 凭据持久化 ----------

  function loadToken() {
    try {
      const cred = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      // token 与网关绑定;网关变了旧的不可用
      if (cred.token && cred.gateway === gateway) return cred
    } catch { /* 不存在或损坏按未配对处理 */ }
    return null
  }

  function saveToken(cred) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenPath, JSON.stringify({ ...cred, gateway }, null, 2), { mode: 0o600 })
  }

  function removeToken() {
    try { fs.unlinkSync(tokenPath) } catch { /* 本来就不存在 */ }
  }

  // ---------- 网关配对 API ----------

  async function createPairSession() {
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

  /** @returns {Promise<{status:string, token?:string, deviceId?:string} | 'gone'>} */
  async function pollPairStatus(pairingId, secret) {
    const resp = await fetch(
      `${gateway}/dsh/pair-sessions/${encodeURIComponent(pairingId)}/status?s=${encodeURIComponent(secret)}`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (resp.status === 410) return 'gone'
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

  /** 配对:建会话 → 出 QR → 2s 轮询;claimed 落盘返回凭据;410/重新生成 → 重来。 */
  async function pair() {
    while (!stopped) {
      const gen = pairGen
      let sess
      try {
        sess = await createPairSession()
      } catch (err) {
        state.phase = 'pairing'
        state.detail = `网关不可达:${errMsg(err)},${PAIR_RETRY_MS / 1000} 秒后重试`
        warn(state.detail)
        await sleep(PAIR_RETRY_MS)
        continue
      }
      // ≥128bit secret,base64url 编码进 QR;e2eKey 为 32 字节 E2E 密钥,k 参数下发(直接作 AES-256-GCM 密钥)
      const secret = crypto.randomBytes(32).toString('base64url')
      const e2eKey = crypto.randomBytes(32).toString('base64url')
      const qrText = `oneboxdsh://pair?v=1&g=${gateway}&p=${sess.pairingId}&s=${secret}&k=${e2eKey}`
      state.phase = 'pairing'
      state.deviceId = ''
      state.detail = ''
      state.expiresAt = Date.now() + (sess.expiresIn || 300) * 1000
      state.qrSvg = await QRCode.toString(qrText, { type: 'svg', margin: 1 })
      state.payload = qrText // 原始配对链接(供复制/调试用,仅 loopback 页面可见)
      log(`配对会话 ${sess.pairingId} 已创建,等待扫码`)

      while (!stopped && gen === pairGen) {
        await sleep(PAIR_POLL_MS)
        if (stopped || gen !== pairGen) break
        let result
        try {
          result = await pollPairStatus(sess.pairingId, secret)
        } catch (err) {
          state.detail = `轮询失败:${errMsg(err)}`
          continue // 网络抖动不重建会话,下轮再试
        }
        if (result === 'gone') {
          log('配对会话已过期,重新生成')
          break
        }
        if (result.status === 'claimed' && result.token) {
          const cred = { token: result.token, deviceId: result.deviceId || '', e2eKey }
          try {
            saveToken(cred)
          } catch (err) {
            warn(`写入 token 失败:${errMsg(err)}`)
          }
          log(`配对成功,设备 ${cred.deviceId}`)
          state.qrSvg = ''
          state.payload = ''
          return cred
        }
      }
    }
    return null
  }

  /** 一条控制隧道会话;resolve 'unauthorized'(回配对)或 'dropped'(退避重连)。 */
  function session(cred) {
    return new Promise((resolve) => {
      state.phase = 'connecting'
      state.deviceId = cred.deviceId
      // 旧凭据(无 e2eKey)= 明文隧道;key 损坏按明文降级,不阻断连接
      let cipher = null
      if (cred.e2eKey) {
        try {
          cipher = createCipher(cred.e2eKey)
        } catch (err) {
          warn(`E2E 密钥无效,回退明文:${errMsg(err)}`)
        }
      }
      const url = `${wsBase(gateway)}/dsh/agent?token=${encodeURIComponent(cred.token)}`
      const tunnel = new Tunnel({
        url,
        upstream,
        cipher,
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
        qrSvg: state.qrSvg,
        payload: state.payload || '',
        expiresAt: state.expiresAt,
        detail: state.detail,
        gateway,
        upstream,
        e2e: state.e2e, // 当前凭据是否携带 E2E 密钥
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
    log(`已加载,页面 http://${ctx.webServer.host}:${ctx.webServer.port}/onebox-bridge`)
    return () => {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
      currentTunnel?.close('dropped')
    }
  })
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
