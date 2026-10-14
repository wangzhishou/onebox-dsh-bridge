import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAIR_POLL_MIN_MS, PAIR_POLL_MAX_MS, nextPairPollMs } from '../lib/backoff.js'

test('退避序列: 1s 起步逐次翻倍', () => {
  let ms = PAIR_POLL_MIN_MS
  const seq = [ms]
  for (let i = 0; i < 6; i++) {
    ms = nextPairPollMs(ms)
    seq.push(ms)
  }
  assert.deepEqual(seq, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
})

test('上限 30s 不再增长', () => {
  assert.equal(nextPairPollMs(PAIR_POLL_MAX_MS), PAIR_POLL_MAX_MS)
})

test('429 Retry-After 取较大值', () => {
  // 当前 4s, 翻倍 8s, 服务端建议 10s → 10s
  assert.equal(nextPairPollMs(4000, 10), 10_000)
  // 服务端建议 1s 小于翻倍值 → 翻倍值
  assert.equal(nextPairPollMs(4000, 1), 8000)
  // 服务端建议可以突破 30s 上限 (服务端更知道该慢多少)
  assert.equal(nextPairPollMs(30_000, 60), 60_000)
})

test('Retry-After 缺省/0 时按纯退避', () => {
  assert.equal(nextPairPollMs(1000), 2000)
  assert.equal(nextPairPollMs(1000, 0), 2000)
})
