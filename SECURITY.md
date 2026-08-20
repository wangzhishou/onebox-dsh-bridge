# Security Policy

onebox-dsh-bridge gives a phone remote control over a real AI agent running on your computer. This document describes the security model and how to report issues.

## Threat model

| Asset | Protection |
|---|---|
| Pairing secret (≥128 bit) | Generated locally, encoded only into the on-screen QR code — never sent to the relay server |
| Message content (phone ↔ computer) | AES-256-GCM end-to-end encryption with the pairing key; the cloud relay forwards ciphertext only |
| Device token | Stored in `dataDir/token.json` with mode `0600`; invalidated automatically when the gateway changes; a 401 from the relay deletes it locally and returns to scan-to-pair |
| Pairing QR code | Single-use, expires after 10 minutes, regenerating invalidates the previous session |
| `/onebox-bridge` page | No extra auth, same as `dsh web` itself — loopback-only by default |

## Rules you must follow

- **Never expose `dsh web` (or this plugin's page) directly to the public internet.** The QR code contains the pairing secret; anyone who scans it owns your agent. `dsh web` refuses `--host 0.0.0.0` for exactly this reason — do not work around it.
- Treat anyone who can see your screen while the QR code is shown as a potential pairing attacker. Use **Regenerate QR code** if in doubt, and **Unbind & re-pair** to revoke a device (also revocable from the app's "My Computers" list).
- The relay requires a signed-in OneBox account; guest access is rejected server-side.

## Scope notes

- The plugin's runtime dependencies are only `ws` and `qrcode`. There is no install-time script, no telemetry, and no network traffic besides the configured gateway and the local dsh upstream.
- Installing any dsh plugin runs third-party code with your own user permissions — this is inherent to the harness, not specific to this plugin.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately via GitHub Security Advisories on [wangzhishou/onebox-dsh-bridge](https://github.com/wangzhishou/onebox-dsh-bridge/security). We aim to respond within 72 hours.
