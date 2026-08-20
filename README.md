# onebox-dsh-bridge

**English** | [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/onebox-dsh-bridge)](https://www.npmjs.com/package/onebox-dsh-bridge)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Repo](https://img.shields.io/badge/App-OneBox-green)](https://github.com/wangzhishou/OneBox)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that bridges your local `dsh web` to the OneBox cloud relay, so the **OneBox Android app** can reach your computer's AI agent over the public internet — scan-to-pair, token management and tunnel frame multiplexing, all inside the plugin. Your agent is online as soon as `dsh web` starts.

> Built for the open-source [OneBox (万宝盒)](https://github.com/wangzhishou/OneBox) Android app. The plugin page also includes the app download info, so anyone running DSH can pair their phone in a minute.

## How it works

```
OneBox App ⇅ https://api.wanbaohe.com/dsh/* (cloud relay)
                 ⇅ outbound WSS (control tunnel, JSON frame multiplexing)
         onebox-dsh-bridge (this plugin)
                 ⇅ loopback
         local dsh web (127.0.0.1:3080)
```

- Mounts a `/onebox-bridge` page in the dsh web GUI (self-contained HTML, zero external deps) showing the pairing QR code and online status
- Pairing: `POST /dsh/pair-sessions` → a ≥128-bit secret is generated locally and encoded into the QR (`oneboxdsh://pair?v=1&g=…&p=…&s=…`) → polls `GET /dsh/pair-sessions/:id/status?s=…` every 2s; once the app scans and claims, the plugin receives its device token
- Goes online via outbound WSS `/dsh/agent?token=…`; tunnel frames: `http` → local `POST /api/<method>` answered by `http-resp`; `ws-open`/`ws-frame`/`ws-close` bridge the local `/api/events.mux|host` streams
- Control WS drop → all local bridges closed, exponential-backoff reconnect (1s→30s); token 401 (revoked/expired) → local token deleted, back to scan-to-pair state
- **End-to-end encryption**: the pairing key travels only inside the QR code, never through the server; all app ↔ computer traffic is AES-256-GCM encrypted — the relay forwards ciphertext only

## Install

With the dsh CLI installed:

```sh
dsh plugin --profile web add onebox-dsh-bridge
```

Running dsh from a source checkout (prefix commands with `pnpm dsh`, from the deepseek-harness repo root):

```sh
pnpm dsh plugin --profile web add onebox-dsh-bridge
```

The package declares `dsh.bundle`, so `add` automatically merges the plugin row into the profile's composition layer. Restart `dsh web` to take effect.

**Compatibility**: verified against dsh `0.1.0-rc.7` (npm `latest`) and `0.1.0-rc.8` (npm `next`) — pairing page, status API and QR pair-session creation all pass on both. The plugin must live in the `web` profile (it injects the `webServer` service that only the web composition provides).

Installing straight from GitHub also works:

```sh
dsh plugin --profile web add github:wangzhishou/onebox-dsh-bridge
```

## Usage

1. Open `http://127.0.0.1:3080/onebox-bridge` in dsh web (adjust the port to your deployment)
2. In the OneBox app, open **DSH Client → My Computers** and scan the QR code on the page
3. Once the page shows **Online**, pick the device in the app and start chatting with your agent

Page buttons: **Regenerate QR code** (invalidates the old session and creates a new pairing session; codes expire after 10 minutes and are rebuilt automatically) and **Unbind & re-pair** (deletes the local token, back to waiting-for-scan).

## Get the OneBox app

The plugin is the computer-side half; the phone-side half is the free, open-source OneBox Android app:

- **Source code**: [github.com/wangzhishou/OneBox](https://github.com/wangzhishou/OneBox) (Apache-2.0)
- **International**: [Google Play](https://play.google.com/store/apps/details?id=com.shifenmiao.app) · [Official site](https://www.oneboxable.com)
- **中国用户**: [万宝盒官网](https://www.wanbaohe.com) · 小米 / 应用宝 / OPPO / vivo / 华为应用商店搜索「万宝盒」

## Screenshots

| Plugin pairing page | App connect page | App chat control | Feedback & stats |
|---|---|---|---|
| ![pairing page](docs/images/pairing-page.png) | ![connect](docs/images/app-connect.png) | ![chat](docs/images/app-chat.png) | ![feedback](docs/images/app-feedback.png) |

## Configuration

All optional. Priority: environment variable > plugin config > default.

| Key | Env var | Default | Description |
|---|---|---|---|
| `gateway` | `ONEBOX_DSH_GATEWAY` | `https://api.wanbaohe.com` | OneBox gateway. **For the international app (Google Play build, api.oneboxable.com) you must set this to `https://api.oneboxable.com`**, otherwise scanned pairings land in the CN database and the login state won't match |
| `upstream` | `ONEBOX_DSH_UPSTREAM` | `127.0.0.1:3080` | Local dsh address (host:port) |
| `deviceName` | — | system hostname | Device name reported to the app during pairing |
| `dataDir` | `ONEBOX_DSH_DATA_DIR` | `~/.dsh/profiles/web/onebox-dsh-bridge` | Token storage directory (token.json, mode 0600; old tokens are invalidated automatically after a gateway change) |

To change config, override the whole row in the profile's `~/.dsh/profiles/web/cordis.patch.yml` (a patch replaces the entire `config` value — list every key):

```yaml
- id: onebox-dsh-bridge
  name: 'onebox-dsh-bridge'
  config:
    gateway: https://api.wanbaohe.com
    upstream: 127.0.0.1:3080
    deviceName: My Mac
```

## Uninstall

```sh
dsh plugin --profile web remove onebox-dsh-bridge
```

Optionally delete the credentials directory `~/.dsh/profiles/web/onebox-dsh-bridge/`; paired devices can be revoked in the app under **My Computers**.

## Notes

- The `/onebox-bridge` page, like dsh web itself, has no extra auth (loopback-only by default); the QR code contains the pairing secret — never expose dsh web directly to the public internet
- Runtime dependencies: just `ws` + `qrcode`
