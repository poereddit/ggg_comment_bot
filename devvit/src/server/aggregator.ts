import {context, reddit as realReddit, redis as realRedis, settings} from '@devvit/web/server'
import {
  DEFAULT_ROSTER, MAX_AGE_MS, createSnippet, formatLine, isEmployee, isFresh, parseRoster, planAppend,
} from '../shared/aggregate.ts'

export type SeenComment = {
  id: string // t1_...
  author: string
  body: string
  permalink: string
  postId: string // t3_...
  createdAtMs: number
}

const SEEN_TTL_S = 30 * 24 * 60 * 60
const AGG_TTL_S = 90 * 24 * 60 * 60
const LOCK_TTL_S = 30

const seenKey = (commentId: string) => `seen:${commentId}`
const aggKey = (postId: string) => `agg:${postId}`
const lockKey = (postId: string) => `lock:${postId}`

// What aggregate() needs from Devvit, narrowed so tests can pass in fakes.
export type CommentLike = {
  id: string
  body: string
  edit(opts: {text: string}): Promise<unknown>
  reply(opts: {text: string; runAs: 'APP'}): Promise<CommentLike>
  distinguish(makeSticky?: boolean): Promise<void>
}
export type Deps = {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<unknown>
    del(key: string): Promise<unknown>
    expire(key: string, seconds: number): Promise<unknown>
    expireTime(key: string): Promise<number>
    incrBy(key: string, value: number): Promise<number>
  }
  reddit: {
    getCommentById(id: string): Promise<CommentLike>
    submitComment(opts: {id: string; text: string; runAs: 'APP'}): Promise<CommentLike>
  }
}
const realDeps = {redis: realRedis, reddit: realReddit} as unknown as Deps

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function loadRoster(): Promise<Set<string>> {
  return parseRoster((await settings.get<string>('roster')) ?? DEFAULT_ROSTER)
}

// Two comments in one thread can arrive together, and both would read the same body and
// overwrite each other's line. incrBy is atomic, so whoever gets 1 holds the lock.
async function withPostLock<T>(redis: Deps['redis'], postId: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(postId)
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await redis.incrBy(key, 1)) === 1) {
      await redis.expire(key, LOCK_TTL_S)
      try {
        return await fn()
      } finally {
        await redis.del(key)
      }
    }
    // A holder that died between incrBy and expire would leave a lock with no expiry.
    if ((await redis.expireTime(key)) === -1) await redis.expire(key, LOCK_TTL_S)
    await sleep(500 + attempt * 250)
  }
  throw new Error(`could not lock ${postId}`)
}

async function findAggregation({redis, reddit}: Deps, postId: string) {
  const id = await redis.get(aggKey(postId))
  if (!id) return null
  try {
    const comment = await reddit.getCommentById(id)
    // Reddit still returns a deleted or mod-removed comment, with its text replaced. It can't be edited.
    if (comment.body === '[deleted]' || comment.body === '[removed]') return null
    return comment
  } catch {
    return null // inaccessible: start a new one
  }
}

// Returns true if the comment was added to the thread's summary comment.
export async function aggregate(c: SeenComment, roster: Set<string>, deps: Deps = realDeps): Promise<boolean> {
  if (!isEmployee(c.author, roster)) return false
  const {redis, reddit} = deps
  return withPostLock(redis, c.postId, async () => {
    // Marked only after success, so a failed attempt is retried by the next sweep.
    if (await redis.get(seenKey(c.id))) return false

    const line = formatLine({
      author: c.author,
      permalink: c.permalink,
      snippet: createSnippet(c.body),
    })
    const existing = await findAggregation(deps, c.postId)
    const plan = planAppend(existing?.body ?? null, line)

    let latestId: string
    if (plan.kind === 'create') {
      const created = await reddit.submitComment({id: c.postId, text: plan.body, runAs: 'APP'})
      await created.distinguish(true)
      latestId = created.id
    } else if (plan.kind === 'edit' && existing) {
      await existing.edit({text: plan.body})
      latestId = existing.id
    } else if (plan.kind === 'chain' && existing) {
      if (plan.footerEdit !== null) await existing.edit({text: plan.footerEdit})
      const reply = await existing.reply({text: plan.replyBody, runAs: 'APP'})
      await reply.distinguish() // replies are distinguished, only the first is stickied
      latestId = reply.id
    } else {
      throw new Error('unreachable plan state')
    }

    await redis.set(aggKey(c.postId), latestId)
    await redis.expire(aggKey(c.postId), AGG_TTL_S)
    await redis.set(seenKey(c.id), '1')
    await redis.expire(seenKey(c.id), SEEN_TTL_S)
    return true
  })
}

// Safety net for triggers that never arrived: look at each employee's own recent comments.
export async function sweep(): Promise<{checked: number; added: number}> {
  const roster = await loadRoster()
  const sub = context.subredditName.toLowerCase()
  const now = Date.now()
  let checked = 0
  let added = 0
  for (const username of roster) {
    try {
      const comments = await realReddit.getCommentsByUser({username, sort: 'new', limit: 25}).all()
      for (const comment of comments) {
        if (comment.subredditName.toLowerCase() !== sub) continue
        if (!isFresh(comment.createdAt.getTime(), now, MAX_AGE_MS)) continue
        checked++
        const did = await aggregate(
          {
            id: comment.id,
            author: comment.authorName,
            body: comment.body,
            permalink: comment.permalink,
            postId: comment.postId,
            createdAtMs: comment.createdAt.getTime(),
          },
          roster,
        )
        if (did) added++
      }
    } catch (err) {
      console.error(`sweep failed for u/${username}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return {checked, added}
}
