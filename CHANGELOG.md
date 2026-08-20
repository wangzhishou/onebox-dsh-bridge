# Changelog

All notable changes to onebox-dsh-bridge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
