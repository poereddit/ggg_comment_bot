import assert from 'node:assert/strict'
import {test} from 'node:test'
import {type TrackerDeps, track} from './tracker.ts'

function deps(over: Partial<TrackerDeps> = {}) {
  const kv = new Map<string, string>()
  const sent: unknown[] = []
  const d: TrackerDeps = {
    redis: {
      get: async k => kv.get(k), set: async (k, v) => void kv.set(k, v), expire: async () => {},
      del: async k => void kv.delete(k),
      incrBy: async (k, by) => { const v = Number(kv.get(k) ?? 0) + by; kv.set(k, String(v)); return v },
    },
    webhook: async () => 'https://discord.com/api/webhooks/1/x',
    enabled: async () => true,
    send: async (_u, b) => { sent.push(b); return {ok: true, status: 200} },
    ...over,
  }
  kv.set('tracker:since', '1')
  return {d, sent, kv}
}
const embed = async () => ({author: {name: 'a', url: 'u', icon_url: 'i'}, title: 't', url: 'u', color: 1, timestamp: 'x'})

test('an item is posted once', async () => {
  const {d, sent} = deps()
  assert.equal(await track('t1_a', Date.now(), embed, d), true)
  assert.equal(await track('t1_a', Date.now(), embed, d), false)
  assert.equal(sent.length, 1)
})

test('nothing is posted when the tracker is off, unset or the item is old', async () => {
  for (const over of [{enabled: async () => false}, {webhook: async () => undefined}]) {
    const {d, sent} = deps(over)
    assert.equal(await track('t1_a', Date.now(), embed, d), false)
    assert.equal(sent.length, 0)
  }
  const {d, sent} = deps()
  assert.equal(await track('t1_a', Date.now() - 2 * 86400000, embed, d), false)
  assert.equal(sent.length, 0)
})

test('a failed send is retried by the next attempt', async () => {
  let fail = true
  const {d, sent} = deps({send: async (_u, b) => { if (fail) return {ok: false, status: 500}; sent.push(b); return {ok: true, status: 200} }})
  await assert.rejects(track('t1_a', Date.now(), embed, d))
  fail = false
  assert.equal(await track('t1_a', Date.now(), embed, d), true)
  assert.equal(sent.length, 1)
})

test('items from before the tracker was turned on are skipped', async () => {
  const {d, sent, kv} = deps()
  kv.delete('tracker:since')
  const old = Date.now() - 10 * 60 * 1000
  assert.equal(await track('t1_new', Date.now() - 1000, embed, d), true)
  assert.equal(await track('t1_old', old, embed, d), false)
  assert.equal(sent.length, 1)
})
