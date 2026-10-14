# Changelog

All notable changes to onebox-dsh-bridge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [0.2.1] - 2026-10-14

### Changed

- **配对轮询改指数退避**: `GET /dsh/pair-sessions/:id/status` 从固定 2s 轮询改为
  1s 起步、翻倍、上限 30s 的指数退避 (`lib/backoff.js`), 并采纳服务端 429 响应的
  `Retry-After` 头。常驻等待配对时请求量降为原来的 ~1/15, 显著降低网关与按命令
  计费的 Redis (Upstash) 开销。扫码响应速度不受影响 (新会话仍从 1s 起步)

## [0.2.0] - 2026-09-14

### Added

- **双部署同时配对**: 默认同时对国内(api.wanbaohe.com)与海外(api.oneboxable.com)两套网关
  各建一个配对会话,页面按 App 渠道标注并排展示两张二维码;哪张先被扫码认领,隧道就建到哪边。
  App 登录 JWT 只在所属部署有效,单网关形态下扫错部署必然 claim 401
- 配置新增 `gateways` 数组与环境变量 `ONEBOX_DSH_GATEWAYS`(逗号分隔);
  单值 `gateway` / `ONEBOX_DSH_GATEWAY` 继续支持(等价于单元素数组)

### Changed

- `/onebox-bridge/api/status`: 顶层 `qrSvg`/`payload`/`expiresAt` 移入 `pairs[]` 数组元素
  (每项含 `gateway`/`kind`/`qrSvg`/`payload`/`expiresAt`/`detail`);顶层 `gateway` 改为当前已连接网关

## [0.1.3] - 2026-09-12

### Fixed

- **dsh 0.1.5 起隧道请求全部 401**:该版本对 `/api` 的每个请求(含 `/api/remote.mux` 的 WS 升级)
  都强制浏览器鉴权,loopback 也不例外、`Authorization: Bearer` 不被识别。插件现在会
  用 `ctx.connection.authenticatedUrl` 换取本机会话 cookie 并缓存,HTTP 与 WS 升级都带上;
  401 时丢弃缓存重换一次重试(`lib/session-cookie.js`)

### Added

- `tools/lan-proxy.mjs`:局域网联调反代(注入会话 cookie,把本机 dsh 的 `/api` 暴露给手机直连,
  绕开 cookie 门槛),用法见 README「联调测试」

## [0.1.2] - 2026-08-20

### Changed

- Pairing page `/onebox-bridge` now defaults to English with a one-tap 中文 switch (remembered via localStorage, auto-follows browser language on first visit)
- App download links on the pairing page: added Google Play for international users

## [0.1.1] - 2026-08-20

### Changed

- README rewritten with English as the default language plus a linked Chinese version (README.zh-CN.md)
- Install instructions now prefer the npm channel (`dsh plugin add onebox-dsh-bridge`)
- Added OneBox app download section (cross-links: GitHub, Google Play, official sites)
- package.json: English-first description, keywords, repository/homepage/bugs metadata

## [0.1.0] - 2026-08-19

### Added

- First release: dsh plugin bridging local `dsh web` to the OneBox Android app over the public internet
- QR scan-to-pair via `/dsh/pair-sessions`, with a self-contained `/onebox-bridge` page in the dsh Web UI
- End-to-end encryption (AES-256-GCM): pairing key travels only inside the QR code, the relay forwards ciphertext only
- Outbound WSS control tunnel with JSON frame multiplexing (`http` / `ws-open` / `ws-frame` / `ws-close`)
- Exponential-backoff reconnect (1s→30s); token 401 → automatic return to scan-to-pair state
- Config: `gateway` / `upstream` / `deviceName` / `dataDir` (env override supported)
