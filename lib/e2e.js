// E2E 加密:AES-256-GCM,密钥在配对时由本端生成、经 QR 的 k 参数下发给 App
// (base64url 无填充,43 字符 = 32 字节,直接作密钥,不再派生)。
// 密文帧形态: JSON 字符串 {"e2e":1,"d":"<base64url无填充(nonce(12) ‖ ciphertext ‖ tag(16))>"}。
// 发送必加密(持有 key 时);接收宽容:输入不是带 "e2e" 字段的 JSON 时按明文原样透传
// (兼容旧版 App/明文形态);是 e2e 帧但解密失败(篡改/密钥不匹配)则 throw,由调用方处置。
// 与 Android 端 Kotlin 实现严格一致,任何改动需两端同步。
import crypto from 'node:crypto'

const NONCE_LEN = 12
const TAG_LEN = 16

/**
 * @param {string} keyBase64url 32 字节密钥的 base64url(无填充)编码
 * @returns {{ encryptText: (plain: string) => string, decryptText: (text: string) => string }}
 */
export function createCipher(keyBase64url) {
  const key = Buffer.from(keyBase64url, 'base64url')
  if (key.length !== 32) throw new Error(`E2E 密钥须为 32 字节,实际 ${key.length} 字节`)

  /** 明文 → e2e 密文帧 JSON 字符串。 */
  function encryptText(plain) {
    const nonce = crypto.randomBytes(NONCE_LEN)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const packed = Buffer.concat([nonce, ct, cipher.getAuthTag()])
    return JSON.stringify({ e2e: 1, d: packed.toString('base64url') })
  }

  /** e2e 密文帧 → 明文;非 e2e 输入原样透传;e2e 帧解密失败 throw。 */
  function decryptText(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return text // 非 JSON:明文透传
    }
    if (!frame || typeof frame !== 'object' || !('e2e' in frame)) return text // 明文 JSON:透传
    const packed = Buffer.from(String(frame.d ?? ''), 'base64url')
    if (packed.length < NONCE_LEN + TAG_LEN) throw new Error('E2E 密文帧长度不足')
    const nonce = packed.subarray(0, NONCE_LEN)
    const tag = packed.subarray(packed.length - TAG_LEN)
    const ct = packed.subarray(NONCE_LEN, packed.length - TAG_LEN)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }

  return { encryptText, decryptText }
}
