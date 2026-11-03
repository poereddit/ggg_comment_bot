import assert from 'node:assert/strict'
import {test} from 'node:test'
import {BODY_LIMIT, FOOTER, HEADER} from '../shared/aggregate.ts'
import {type CommentLike, type Deps, aggregate} from './aggregator.ts'

// In-memory stand-ins for Redis and the Reddit API, enough to exercise the real aggregate().
function fakes() {
  const kv = new Map<string, string>()
  const comments = new Map<string, FakeComment>()
  const log: string[] = []
  let n = 0
  class FakeComment implements CommentLike {
    id = `t1_bot${++n}`
    sticky = false
    body: string
    parent: string
    constructor(body: string, parent: string) {
      this.body = body
      this.parent = parent
      comments.set(this.id, this)
    }
    async edit({text}: {text: string}) { await tick(); this.body = text; log.push(`edit ${this.id}`) }
    async reply({text}: {text: string}) { await tick(); log.push(`reply ${this.id}`); return new FakeComment(text, this.id) }
    async distinguish(sticky = false) { this.sticky = sticky }
  }
  const tick = () => new Promise<void>(r => setTimeout(r, 5))
  const deps: Deps = {
    redis: {
      get: async k => kv.get(k),
      set: async (k, v) => void kv.set(k, v),
      del: async k => void kv.delete(k),
      expire: async () => {},
      expireTime: async () => 30,
      incrBy: async (k, by) => { const v = Number(kv.get(k) ?? 0) + by; kv.set(k, String(v)); return v },
    },
    reddit: {
      getCommentById: async id => { const c = comments.get(id); if (!c) throw new Error('404'); return c },
      submitComment: async ({id, text}) => { await tick(); log.push(`submit on ${id}`); return new FakeComment(text, id) },
    },
  }
  return {deps, kv, comments, log}
}

const roster = new Set(['carol_ggg', 'dave_ggg'])
const c = (id: string, author: string, body = 'hello there', postId = 't3_p1') =>
  ({id, author, body, permalink: `/r/pathofexile/comments/p1/t/${id}/`, postId, createdAtMs: 0})

test('first comment creates a stickied summary, later ones edit it', async () => {
  const {deps, comments} = fakes()
  assert.equal(await aggregate(c('t1_a', 'Carol_GGG'), roster, deps), true)
  assert.equal(await aggregate(c('t1_b', 'Dave_GGG'), roster, deps), true)
  assert.equal(comments.size, 1)
  const bot = [...comments.values()][0]!
  assert.equal(bot.sticky, true)
  assert.ok(bot.body.startsWith(HEADER))
  assert.ok(bot.body.includes('Carol_GGG') && bot.body.includes('Dave_GGG'))
})

test('non-employees and repeats are ignored', async () => {
  const {deps, comments} = fakes()
  assert.equal(await aggregate(c('t1_a', 'someone_else'), roster, deps), false)
  assert.equal(await aggregate(c('t1_b', 'Carol_GGG'), roster, deps), true)
  assert.equal(await aggregate(c('t1_b', 'Carol_GGG'), roster, deps), false)
  assert.equal([...comments.values()][0]!.body.split('Carol_GGG').length - 1, 1)
})

test('two comments arriving together both end up in the summary', async () => {
  const {deps, comments} = fakes()
  await aggregate(c('t1_a', 'Carol_GGG'), roster, deps)
  await Promise.all([
    aggregate(c('t1_b', 'Dave_GGG', 'second'), roster, deps),
    aggregate(c('t1_c', 'Carol_GGG', 'third'), roster, deps),
  ])
  const body = [...comments.values()][0]!.body
  assert.ok(body.includes('*second*') && body.includes('*third*'))
})

test('a full summary gets the footer and a distinguished, unstickied reply', async () => {
  const {deps, comments, kv} = fakes()
  await aggregate(c('t1_a', 'Carol_GGG'), roster, deps)
  const first = [...comments.values()][0]!
  first.body = first.body + 'x'.repeat(BODY_LIMIT)
  await aggregate(c('t1_b', 'Dave_GGG', 'overflow'), roster, deps)
  assert.ok(first.body.endsWith(FOOTER))
  assert.equal(comments.size, 2)
  const reply = [...comments.values()][1]!
  assert.equal(reply.parent, first.id)
  assert.equal(reply.sticky, false)
  assert.ok(reply.body.startsWith(HEADER) && reply.body.includes('*overflow*'))
  assert.equal(kv.get('agg:t3_p1'), reply.id)
})

test('a deleted summary is replaced instead of failing', async () => {
  const {deps, comments} = fakes()
  await aggregate(c('t1_a', 'Carol_GGG'), roster, deps)
  comments.clear()
  assert.equal(await aggregate(c('t1_b', 'Dave_GGG'), roster, deps), true)
  assert.equal(comments.size, 1)
})

test('a removed summary, which Reddit still returns, is replaced too', async () => {
  const {deps, comments} = fakes()
  await aggregate(c('t1_a', 'Carol_GGG'), roster, deps)
  const old = [...comments.values()][0]!
  old.body = '[removed]'
  assert.equal(await aggregate(c('t1_b', 'Dave_GGG'), roster, deps), true)
  assert.equal(comments.size, 2)
  const fresh = [...comments.values()][1]!
  assert.equal(fresh.sticky, true)
  assert.ok(fresh.body.startsWith(HEADER) && fresh.body.includes('Dave_GGG'))
})

test('a failed Reddit call leaves the comment unmarked so the sweep retries it', async () => {
  const {deps, kv} = fakes()
  deps.reddit.submitComment = async () => { throw new Error('RATELIMIT') }
  await assert.rejects(aggregate(c('t1_a', 'Carol_GGG'), roster, deps))
  assert.equal(kv.get('seen:t1_a'), undefined)
  assert.equal(kv.get('lock:t3_p1'), undefined)
})
