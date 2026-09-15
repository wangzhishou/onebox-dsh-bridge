// 自包含 GUI 页面(无外部依赖):QR + 状态轮询 + 重新生成/解绑按钮。
// 页面骨架静态返回,数据由页面 JS 轮询 /onebox-bridge/api/status 填充。
// 多网关形态:配对阶段按 pairs[] 每个网关渲染一张卡片(渠道标注 + QR + 倒计时)。
// 英文默认,右上角可切中文(localStorage 记忆)。
export function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OneBox DSH Bridge</title>
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
  .pair { padding: 4px 0 8px; }
  .pair + .pair { border-top: 1px solid #eee; margin-top: 16px; padding-top: 20px; }
  .pair .label { font-size: 14px; font-weight: 600; }
  .pair .host { font-size: 12px; color: #8a8a8e; word-break: break-all; margin: 2px 0 12px; }
  .pair svg { width: 220px; height: 220px; background: #fff; }
  .pair .cd { font-variant-numeric: tabular-nums; font-size: 12px; color: #8a8a8e; margin-top: 8px; }
  .pair .pd { font-size: 12px; color: #b3261e; margin-top: 6px; }
  .pair .wait { font-size: 13px; color: #8a8a8e; padding: 32px 0; }
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
  .about { margin-top: 16px; text-align: left; }
  .about h2 { font-size: 16px; margin: 0 0 8px; }
  .about p, .about li { font-size: 13px; line-height: 1.8; color: #4a4a4e; }
  .about ol { margin: 8px 0; padding-left: 20px; }
  .about a { color: #2b5cb8; text-decoration: none; }
  .about .e2e { font-size: 12px; color: #8a8a8e; margin-top: 8px; }
  #lang { position: fixed; top: 12px; right: 16px; font-size: 13px; color: #8a8a8e;
          cursor: pointer; user-select: none; }
  #lang b { color: #2b5cb8; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    .about p, .about li { color: #b8b8be; }
    .about a { color: #7aa2f7; }
    body { background: #141416; color: #f2f2f5; }
    .card { background: #1e1e22; }
    .pair + .pair { border-top-color: #2c2c32; }
    .hint { color: #b8b8be; } .hint b { color: #f2f2f5; }
    button { background: #2c2c32; color: #f2f2f5; }
    #lang b { color: #7aa2f7; }
  }
</style>
</head>
<body>
<div id="lang"></div>
<main>
  <h1 data-t="title"></h1>
  <div class="sub">onebox-dsh-bridge · <span data-t="subtitle"></span></div>
  <div class="card">
    <div id="status"></div>
    <div id="pairs"></div>
    <div id="hint" class="hint"></div>
    <div id="device" class="meta"></div>
    <div id="detail" class="meta"></div>
    <button id="regen" data-t="regen"></button>
    <button id="unbind" class="danger" hidden data-t="unbind"></button>
  </div>
  <div class="card about">
    <h2 data-t="aboutTitle"></h2>
    <p data-t="aboutBody"></p>
    <ol>
      <li data-t="step1"></li>
      <li data-t="step2"></li>
      <li data-t="step3"></li>
    </ol>
    <p class="e2e" data-t="e2e"></p>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id)

const I18N = {
  en: {
    title: 'OneBox DSH Bridge',
    subtitle: 'exposes this machine\\'s dsh via the cloud relay for phone access',
    regen: 'Regenerate QR code',
    unbind: 'Unbind & re-pair',
    aboutTitle: 'Scan with what? — the OneBox app',
    aboutBody: '<b>OneBox (万宝盒)</b> is a free, open-source Android toolbox — fully transparent source code — with a built-in "DSH Client". Install it and scan the QR code above to command this computer\\'s DeepSeek Harness from your phone, anywhere.',
    step1: 'Install: <a href="https://play.google.com/store/apps/details?id=com.shifenmiao.app" target="_blank" rel="noopener">Google Play</a> · <a href="https://github.com/wangzhishou/OneBox/releases" target="_blank" rel="noopener">GitHub Releases</a> (source: <a href="https://github.com/wangzhishou/OneBox" target="_blank" rel="noopener">wangzhishou/OneBox</a>)',
    step2: 'Sign in, then open "DSH Client → My Computers"',
    step3: 'Scan the QR code for your app channel (mainland China or international)',
    e2e: 'The pairing key is delivered end-to-end inside the QR code; the relay server forwards ciphertext only and cannot see your conversations.',
    pairKind: { domestic: 'Mainland China app — scan this one', overseas: 'International app (Google Play) — scan this one', custom: 'Custom gateway' },
    pairPreparing: 'Preparing QR code…',
    phase: { boot: ['connecting', 'Starting…'], pairing: ['pairing', 'Waiting for scan'], connecting: ['connecting', 'Connecting to gateway…'], online: ['online', 'Online'], offline: ['offline', 'Offline, reconnecting…'] },
    hintPairing: 'Open the <b>OneBox app</b> → "<b>DSH Client → My Computers</b>" and scan the QR code that matches your app channel.<br>Once paired, this machine\\'s dsh is reachable from the app over the public internet.',
    hintOnline: 'Pick this device under "DSH Client → My Computers" in the app to connect.',
    deviceId: 'Device ID: ',
    countdownLeft: (s) => 'QR code expires in ' + s + 's',
    countdownExpired: 'QR code expired, regenerating…',
  },
  zh: {
    title: '万宝盒 DSH 桥接',
    subtitle: '本机 dsh 经云端中继供手机访问',
    regen: '重新生成二维码',
    unbind: '解除绑定并重新配对',
    aboutTitle: '用什么扫码?——万宝盒 App',
    aboutBody: '<b>万宝盒(OneBox)</b>是一款免费、开源的 Android 工具箱,源码完全公开、安全透明,内置「DSH 客户端」。装上它扫上方二维码,就能在手机上随时指挥这台电脑里的 DeepSeek Harness。',
    step1: '下载安装:<a href="https://github.com/wangzhishou/OneBox/releases" target="_blank" rel="noopener">GitHub Releases</a>(源码仓库:<a href="https://github.com/wangzhishou/OneBox" target="_blank" rel="noopener">wangzhishou/OneBox</a>,官网 <a href="https://www.shifenmiao.com" target="_blank" rel="noopener">shifenmiao.com</a>)',
    step2: '登录后打开「DSH 客户端 → 我的电脑」',
    step3: '按你的 App 渠道(国内版/海外版)扫对应的那张二维码',
    e2e: '配对密钥经二维码端到端下发,中继服务器只转发密文,看不到你的对话内容。',
    pairKind: { domestic: '国内渠道 App 扫这张', overseas: '海外版 App(Google Play)扫这张', custom: '自建网关' },
    pairPreparing: '二维码准备中…',
    phase: { boot: ['connecting', '启动中…'], pairing: ['pairing', '待扫码'], connecting: ['connecting', '连接网关中…'], online: ['online', '已上线'], offline: ['offline', '离线,重连中…'] },
    hintPairing: '用<b>万宝盒 App</b> 打开「<b>DSH 客户端 → 我的电脑</b>」,扫与你 App 渠道对应的那张二维码。<br>配对成功后本机 dsh 即可在 App 内公网访问。',
    hintOnline: '手机 App「DSH 客户端 → 我的电脑」中选择本设备即可连接。',
    deviceId: '设备 ID:',
    countdownLeft: (s) => '二维码 ' + s + ' 秒后过期',
    countdownExpired: '二维码已过期,正在重新生成…',
  },
}

let lang = localStorage.getItem('onebox-bridge-lang')
if (lang !== 'zh' && lang !== 'en') {
  lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
let lastStatus = null

function t() { return I18N[lang] }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderLangSwitch() {
  $('lang').innerHTML = lang === 'en'
    ? '<b>EN</b> · 中文'
    : 'EN · <b>中文</b>'
}

function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = t().title
  document.querySelectorAll('[data-t]').forEach((el) => {
    el.innerHTML = t()[el.dataset.t]
  })
  renderLangSwitch()
}

function renderPair(p) {
  const label = t().pairKind[p.kind] || p.kind
  const body = p.qrSvg || '<div class="wait">' + t().pairPreparing + '</div>'
  const cd = p.expiresAt ? '<div class="cd" data-expires="' + p.expiresAt + '"></div>' : ''
  const detail = p.detail ? '<div class="pd">' + escapeHtml(p.detail) + '</div>' : ''
  return '<div class="pair"><div class="label">' + label + '</div>' +
    '<div class="host">' + escapeHtml(p.gateway) + '</div>' + body + cd + detail + '</div>'
}

function render(s) {
  lastStatus = s
  const [cls, text] = t().phase[s.phase] || t().phase.boot
  $('status').innerHTML = '<span class="badge ' + cls + '">' + text + '</span>'
  $('pairs').innerHTML = s.phase === 'pairing' ? (s.pairs || []).map(renderPair).join('') : ''
  if (s.phase === 'pairing') {
    $('hint').innerHTML = t().hintPairing
  } else if (s.phase === 'online') {
    $('hint').innerHTML = t().hintOnline
  } else {
    $('hint').innerHTML = ''
  }
  $('device').textContent = s.deviceId ? t().deviceId + s.deviceId : ''
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
$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'zh' : 'en'
  localStorage.setItem('onebox-bridge-lang', lang)
  applyStatic()
  if (lastStatus) render(lastStatus)
})

setInterval(() => {
  document.querySelectorAll('.cd[data-expires]').forEach((el) => {
    const left = Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000))
    el.textContent = left > 0 ? t().countdownLeft(left) : t().countdownExpired
  })
}, 1000)

applyStatic()
refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}
