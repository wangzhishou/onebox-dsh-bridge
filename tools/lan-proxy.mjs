#!/usr/bin/env node
// LAN 联调反代:把本机 dsh web 的 /api 暴露到局域网,并自动注入浏览器会话 cookie。
//
// 为什么需要:DSH 0.1.5 起 /api 的每个请求(含 /api/remote.mux 的 WS 升级)都要过
// connection.requestRejection 的浏览器鉴权——loopback 也一样,令牌不支持 Bearer,
// 所以手机 App 的「LAN 直连」会直接 401。本脚本做三件事:
//   1. 用 dsh web 启动时打印的 ?token=… 换一次浏览器 cookie(与插件 lib/session-cookie.js 同法)
//   2. 监听 0.0.0.0:<port>,把请求 Host 改写成 upstream(过 Host 围栏)后转发,并带上 Cookie
//   3. WS 升级同样转发(ws 库),App 的 /api/remote.mux 逻辑流因此可用
//
// 用法(在 Mac 上,与 dsh web 同一台机器):
//   node tools/lan-proxy.mjs --token <dsh web URL 里的 token> [--port 3081] [--upstream 127.0.0.1:3080]
// 然后在 App 的「DSH 客户端 → 直连」里填 http://<Mac 的局域网 IP>:3081
//
// 注意:这是**联调工具**,给局域网内任何设备开放了本机 dsh 的 /api(权限等同浏览器会话),
// 只在你信任的网络里临时使用,用完 Ctrl-C 关掉。

import http from 'node:http'
import process from 'node:process'
import WebSocket, { WebSocketServer } from 'ws'

function parseArgs(argv) {
  const out = { port: 3081, upstream: '127.0.0.1:3080', token: process.env.DSH_TOKEN || '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--upstream') out.upstream = argv[++i]
    else if (arg === '--token') out.token = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.token) {
  console.log('用法: node tools/lan-proxy.mjs --token <dsh web 的 ?token=…> [--port 3081] [--upstream 127.0.0.1:3080]')
  process.exit(args.help ? 0 : 1)
}

const log = (msg) => console.log(`[lan-proxy] ${msg}`)

/** 换取浏览器会话 cookie(绑定 upstream authority) */
async function mintCookie() {
  const res = await fetch(`http://${args.upstream}/?token=${encodeURIComponent(args.token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const pairs = setCookies.map((c) => c.split(';')[0]).filter(Boolean)
  if (pairs.length === 0) throw new Error(`换取 cookie 失败:HTTP ${res.status} 无 Set-Cookie(token 是否正确?)`)
  return pairs.join('; ')
}

let cookie = await mintCookie()
log(`已换取会话 cookie,转发 ${args.upstream} → 0.0.0.0:${args.port}`)

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: args.upstream, cookie, connection: 'close' }
  delete headers['authorization']
  const upstreamReq = http.request(
    { hostname: args.upstream.split(':')[0], port: Number(args.upstream.split(':')[1] || 80), path: req.url, method: req.method, headers },
    async (upstreamRes) => {
      if (upstreamRes.statusCode === 401) {
        try { cookie = await mintCookie(); log('cookie 失效,已重换(本次请求仍为 401,重试即可)') } catch (err) { log(String(err.message || err)) }
      }
      log(`${req.method} ${req.url} → ${upstreamRes.statusCode}`)
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstreamReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`lan-proxy upstream error: ${err.message}`)
  })
  req.pipe(upstreamReq)
})

// WS 升级(含 /api/remote.mux):手动握手 → 连本机 dsh
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  log(`WS upgrade ${req.url}`)
  const target = new WebSocket(`ws://${args.upstream}${req.url}`, { headers: { cookie } })
  target.on('open', () => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data, isBinary) => target.readyState === WebSocket.OPEN && target.send(data, { binary: isBinary }))
      target.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }))
      client.on('close', () => target.close())
      target.on('close', () => client.close())
    })
  })
  target.on('error', () => socket.destroy())
})

// 原始 TCP 连接日志:排障用(区分"没连上"与"连上了但没走 HTTP")
server.on('connection', (socket) => log(`TCP connect from ${socket.remoteAddress ?? '?'}`))

server.listen(args.port, '0.0.0.0', () => {
  log(`就绪:App 直连地址 http://<本机局域网 IP>:${args.port}(Ctrl-C 退出)`)
})
