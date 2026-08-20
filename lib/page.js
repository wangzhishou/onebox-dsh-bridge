// 自包含 GUI 页面(无外部依赖):QR + 状态轮询 + 重新生成/解绑按钮。
// 页面骨架静态返回,数据由页面 JS 轮询 /onebox-bridge/api/status 填充。
export function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>万宝盒 DSH 桥接</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
         margin: 0; min-height: 100vh; display: flex; justify-content: center;
         background: #f5f6f8; color: #1c1c1e; }
  main { max-width: 420px; width: 100%; padding: 32px 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8a8e; font-size: 13px; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 16px; padding: 24px;
          box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
  #qr { display: inline-block; line-height: 0; }
  #qr svg { width: 240px; height: 240px; background: #fff; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px;
           font-size: 13px; font-weight: 600; margin-bottom: 16px; }
  .badge.pairing   { background: #fff3d6; color: #8a6100; }
  .badge.online    { background: #dcf5e3; color: #1d7a3d; }
  .badge.offline   { background: #ffe1e1; color: #b3261e; }
  .badge.connecting{ background: #e3ecff; color: #2b5cb8; }
  .hint { font-size: 14px; line-height: 1.8; color: #4a4a4e; margin: 16px 0; text-align: left; }
  .hint b { color: #1c1c1e; }
  .meta { font-size: 12px; color: #8a8a8e; word-break: break-all; margin-top: 8px; }
  button { margin-top: 16px; padding: 10px 20px; border: 0; border-radius: 10px;
           font-size: 14px; cursor: pointer; background: #e8e8ec; color: #1c1c1e; }
  button.danger { background: #ffe1e1; color: #b3261e; }
  button:active { opacity: .7; }
  #countdown { font-variant-numeric: tabular-nums; }
  .about { margin-top: 16px; text-align: left; }
  .about h2 { font-size: 16px; margin: 0 0 8px; }
  .about p, .about li { font-size: 13px; line-height: 1.8; color: #4a4a4e; }
  .about ol { margin: 8px 0; padding-left: 20px; }
  .about a { color: #2b5cb8; text-decoration: none; }
  .about .e2e { font-size: 12px; color: #8a8a8e; margin-top: 8px; }
  @media (prefers-color-scheme: dark) {
    .about p, .about li { color: #b8b8be; }
    .about a { color: #7aa2f7; }
    body { background: #141416; color: #f2f2f5; }
    .card { background: #1e1e22; }
    .hint { color: #b8b8be; } .hint b { color: #f2f2f5; }
    button { background: #2c2c32; color: #f2f2f5; }
  }
</style>
</head>
<body>
<main>
  <h1>万宝盒 DSH 桥接</h1>
  <div class="sub">onebox-dsh-bridge · 本机 dsh 经云端中继供手机访问</div>
  <div class="card">
    <div id="status"></div>
    <div id="qr" hidden></div>
    <div id="countdown" class="meta" hidden></div>
    <div id="hint" class="hint"></div>
    <div id="device" class="meta"></div>
    <div id="detail" class="meta"></div>
    <button id="regen">重新生成二维码</button>
    <button id="unbind" class="danger" hidden>解除绑定并重新配对</button>
  </div>
  <div class="card about">
    <h2>用什么扫码?——万宝盒 App</h2>
    <p><b>万宝盒(OneBox)</b>是一款免费、开源的 Android 工具箱,源码完全公开、安全透明,内置「DSH 客户端」。装上它扫上方二维码,就能在手机上随时指挥这台电脑里的 DeepSeek Harness。</p>
    <ol>
      <li>下载安装:<a href="https://github.com/wangzhishou/OneBox/releases" target="_blank" rel="noopener">GitHub Releases</a>(源码仓库:<a href="https://github.com/wangzhishou/OneBox" target="_blank" rel="noopener">wangzhishou/OneBox</a>,官网 <a href="https://www.shifenmiao.com" target="_blank" rel="noopener">shifenmiao.com</a>)</li>
      <li>登录后打开「DSH 客户端 → 我的电脑」</li>
      <li>扫描上方二维码,完成配对</li>
    </ol>
    <p class="e2e">配对密钥经二维码端到端下发,中继服务器只转发密文,看不到你的对话内容。</p>
    <p class="e2e">海外版(Google Play)用户注意:插件 gateway 需配置为 https://api.oneboxable.com(环境变量 ONEBOX_DSH_GATEWAY),否则扫码后无法认领。</p>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const PHASE_TEXT = {
  boot: ['connecting', '启动中…'],
  pairing: ['pairing', '待扫码'],
  connecting: ['connecting', '连接网关中…'],
  online: ['online', '已上线'],
  offline: ['offline', '离线,重连中…'],
}
let expiresAt = 0

function render(s) {
  const [cls, text] = PHASE_TEXT[s.phase] || PHASE_TEXT.boot
  $('status').innerHTML = '<span class="badge ' + cls + '">' + text + '</span>'
  $('qr').hidden = s.phase !== 'pairing'
  if (s.phase === 'pairing') {
    $('qr').innerHTML = s.qrSvg || ''
    expiresAt = s.expiresAt || 0
    $('hint').innerHTML =
      '用<b>万宝盒 App</b> 打开「<b>DSH 客户端 → 我的电脑</b>」,扫码完成配对。<br>' +
      '配对成功后本机 dsh 即可在 App 内公网访问。'
  } else if (s.phase === 'online') {
    $('hint').innerHTML = '手机 App「DSH 客户端 → 我的电脑」中选择本设备即可连接。'
  } else {
    $('hint').innerHTML = ''
  }
  $('countdown').hidden = s.phase !== 'pairing'
  $('device').textContent = s.deviceId ? '设备 ID:' + s.deviceId : ''
  $('detail').textContent = s.detail || ''
  $('unbind').hidden = s.phase !== 'online' && s.phase !== 'offline'
}

async function refresh() {
  try {
    const r = await fetch('/onebox-bridge/api/status')
    render(await r.json())
  } catch { /* 插件重启中,下轮再试 */ }
}

async function post(path) {
  try { await fetch(path, { method: 'POST' }) } catch { /* 同上 */ }
  refresh()
}

$('regen').addEventListener('click', () => post('/onebox-bridge/api/regenerate'))
$('unbind').addEventListener('click', () => post('/onebox-bridge/api/unbind'))

setInterval(() => {
  if ($('countdown').hidden || !expiresAt) return
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  $('countdown').textContent = left > 0 ? '二维码 ' + left + ' 秒后过期' : '二维码已过期,正在重新生成…'
}, 1000)

refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}
