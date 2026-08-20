// 控制隧道:一条出站 WSS 到网关 /dsh/agent,把隧道帧多路复用到本机 dsh。
// 帧契约与 Go 版 dsh-connector (strapi_go/cmd/dsh-connector/tunnel.go) 一致:
//   收 http     {type,id,method,body} → POST http://<upstream>/api/<method> → 回 http-resp {type,id,status,body}
//   收 ws-open  {type,id,path}        → 本地 WS 连 ws://<upstream><path>,桥接帧互转 ws-frame,关闭互传 ws-close
//   收 ws-frame {type,id,text}        → 写对应本地 WS
//   收 ws-close {type,id,reason}      → 关对应本地 WS
// E2E(可选): 持有 cipher 时 http 帧 body 双向、ws 上行帧加密,ws 下行帧解密(宽容透传);
// cipher 为 null(旧凭据)时行为与明文版完全一致。帧格式见 lib/e2e.js 头注释。
import WebSocket from 'ws'

// 服务端 http 帧 30s 超时,客户端略宽裕;超时错误本身也会回传
const HTTP_TIMEOUT_MS = 35_000
// 与 Go 版一致的响应体上限 8MiB
const HTTP_BODY_LIMIT = 8 << 20

export class Tunnel {
  /**
   * @param {{ url: string, upstream: string,
   *   onOpen: () => void,
   *   onClose: (result: 'unauthorized' | 'dropped') => void,
   *   log: (msg: string) => void,
   *   cipher?: { encryptText: (plain: string) => string, decryptText: (text: string) => string } | null }} opts
   */
  constructor({ url, upstream, onOpen, onClose, log, cipher = null }) {
    this.url = url
    this.upstream = upstream
    this.onOpen = onOpen
    this.onClose = onClose
    this.log = log
    this.cipher = cipher
    this.ws = null
    /** @type {Map<string, WebSocket>} bridgeID → 本机 dsh 侧 WS */
    this.bridges = new Map()
    this.done = false
  }

  connect() {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.log('已连接网关')
      this.onOpen()
    })
    // 注册了 unexpected-response 后 ws 不再为握手失败发 error;401 = token 失效/被吊销
    ws.on('unexpected-response', (_req, res) => {
      this.finish(res.statusCode === 401 ? 'unauthorized' : 'dropped')
    })
    ws.on('error', (err) => {
      this.log(`控制 WS 错误: ${err.message}`)
      // error 之后通常紧跟 close;若握手前就失败(无 unexpected-response),兜底结束
      this.finish('dropped')
    })
    ws.on('close', () => this.finish('dropped'))
    ws.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        this.log('忽略无法解析的隧道帧')
        return
      }
      this.handleFrame(frame)
    })
  }

  /** 主动关闭(插件卸载/解绑),result 决定外层是否回到配对态。 */
  close(result = 'dropped') {
    this.finish(result)
  }

  finish(result) {
    if (this.done) return
    this.done = true
    this.closeAllBridges()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
    this.onClose(result)
  }

  send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  handleFrame(f) {
    switch (f.type) {
      case 'http':
        this.handleHTTP(f)
        break
      case 'ws-open':
        this.handleWSOpen(f)
        break
      case 'ws-frame':
        this.handleWSFrame(f)
        break
      case 'ws-close':
        this.handleWSClose(f)
        break
      default:
        this.log(`忽略未知帧类型 ${String(f.type)} (id=${String(f.id)})`)
    }
  }

  /** http 帧 → 真实 POST 本机 dsh /api/<method>,响应原文回传;持有 cipher 时 body 先解密、响应加密。 */
  async handleHTTP(f) {
    const url = `http://${this.upstream}/api/${f.method}`
    const enc = (s) => (this.cipher ? this.cipher.encryptText(s) : s)
    try {
      const reqBody = this.cipher ? this.cipher.decryptText(f.body ?? '') : (f.body ?? '')
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      const buf = Buffer.from(await resp.arrayBuffer())
      const body = buf.subarray(0, HTTP_BODY_LIMIT).toString('utf8')
      this.send({ type: 'http-resp', id: f.id, status: resp.status, body: enc(body) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.send({ type: 'http-resp', id: f.id, status: 502, body: enc(JSON.stringify({ error: msg })) })
    }
  }

  /** 对本机 dsh 建立真实 WS,本地帧 → ws-frame 上行。 */
  handleWSOpen(f) {
    const local = new WebSocket(`ws://${this.upstream}${f.path}`)
    let tracked = false

    local.on('open', () => {
      if (this.done) {
        local.close()
        return
      }
      this.bridges.set(f.id, local)
      tracked = true
    })
    local.on('message', (data) => {
      const text = data.toString()
      this.send({ type: 'ws-frame', id: f.id, text: this.cipher ? this.cipher.encryptText(text) : text })
    })
    const drop = (reason) => {
      const alive = tracked && this.bridges.delete(f.id)
      local.close()
      // 仅当服务端尚未发 ws-close 时才回告,避免来回踢皮球
      if (alive) this.send({ type: 'ws-close', id: f.id, reason })
    }
    local.on('error', () => {
      if (!tracked) this.send({ type: 'ws-close', id: f.id, reason: 'upstream dial failed' })
    })
    local.on('close', () => drop('upstream closed'))
  }

  /** 服务端下行文本帧 → 写本机 dsh WS;持有 cipher 时先解密(宽容透传,解密失败丢帧)。 */
  handleWSFrame(f) {
    const local = this.bridges.get(f.id)
    if (!local || local.readyState !== WebSocket.OPEN) return
    let text = f.text ?? ''
    if (this.cipher) {
      try {
        text = this.cipher.decryptText(text)
      } catch (err) {
        this.log(`ws 下行帧解密失败,丢弃 (id=${String(f.id)}): ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    local.send(text, (err) => {
      if (err && this.bridges.delete(f.id)) {
        local.close()
        this.send({ type: 'ws-close', id: f.id, reason: 'upstream write failed' })
      }
    })
  }

  /** 服务端要求关闭桥接 → 关本机连接。 */
  handleWSClose(f) {
    const local = this.bridges.get(f.id)
    this.bridges.delete(f.id)
    local?.close()
  }

  /** 会话结束时关掉全部本机连接。 */
  closeAllBridges() {
    for (const local of this.bridges.values()) local.close()
    this.bridges.clear()
  }
}
