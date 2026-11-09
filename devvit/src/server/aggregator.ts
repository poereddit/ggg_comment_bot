import {context, reddit as realReddit, redis as realRedis, settings} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'
import {
  DEFAULT_ROSTER, HEADER, MAX_AGE_MS, createSnippet, formatLine, isEmployee, isFresh, parseRoster, planAppend,
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
  removed?: boolean
  spam?: boolean
  parentId?: string
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
    // The app account's existing summary in a post, stickied head first, or [] if there is none.
    findOwnSummary(postId: string): Promise<CommentLike[]>
  }
}

const sameName = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

// Not cached: the account can be renamed while the app is running.
export async function getAppUsername(): Promise<string | undefined> {
  return (await realReddit.getAppUser())?.username
}

async function findOwnSummary(postId: string): Promise<CommentLike[]> {
  const me = await getAppUsername()
  if (!me) return []
  const ours = (c: {authorName: string; body: string}) => sameName(c.authorName, me) && c.body.startsWith(HEADER)
  // A stickied comment is listed first whatever the sort, so a few top-level comments are enough.
  const top = await realReddit.getComments({postId: postId as T3, limit: 5, pageSize: 5}).all()
  let cur = top.find(c => c.stickied && ours(c))
  const chain = []
  while (cur && chain.length < 25) {
    chain.push(cur)
    const replies = await realReddit.getComments({postId: postId as T3, commentId: cur.id, limit: 100, pageSize: 100}).all()
    cur = replies.find(ours)
  }
  return chain as unknown as CommentLike[]
}

const realDeps = {
  redis: realRedis,
  reddit: {
    getCommentById: (id: string) => realReddit.getCommentById(id as `t1_${string}`),
    submitComment: (opts: {id: string; text: string; runAs: 'APP'}) => realReddit.submitComment(opts as never),
    findOwnSummary,
  },
} as unknown as Deps

// The subreddit can tell the app to stay quiet until its account has a given name. That lets the app
// be installed next to the Python bot and take over the moment Reddit moves u/GGGCommentBot to it.
export async function mayPost(): Promise<boolean> {
  const wanted = ((await settings.get<string>('onlyAs')) ?? '').trim().replace(/^\/?u\//i, '')
  if (!wanted) return true
  const me = await getAppUsername()
  if (sameName(me, wanted)) return true
  console.log(`waiting; the app's account is u/${me}, onlyAs is u/${wanted}`)
  return false
}

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

// A deleted or mod-removed comment is still returned. To a mod account like the app, a removed one
// keeps its text, so the removed and spam flags are checked as well as the placeholder text.
const isGone = (c: CommentLike) => c.removed === true || c.spam === true || c.body === '[deleted]' || c.body === '[removed]'

// The newest comment of a thread's summary, plus the text of every comment in it.
type Summary = {latest: CommentLike; bodies: string[]}

async function findAggregation(deps: Deps, postId: string): Promise<Summary | null> {
  const {redis, reddit} = deps
  const id = await redis.get(aggKey(postId))
  if (!id) return adopt(deps, postId)
  try {
    const comment = await reddit.getCommentById(id)
    // agg: points at the newest comment in the chain. If it or any comment above it, up to the
    // stickied head, was removed, the summary starts again instead of continuing under it.
    const bodies: string[] = []
    let cur: CommentLike = comment
    for (let depth = 0; depth < 25; depth++) {
      if (isGone(cur)) return null
      bodies.push(cur.body)
      if (!cur.parentId || !cur.parentId.startsWith('t1_')) break
      cur = await reddit.getCommentById(cur.parentId)
    }
    return {latest: comment, bodies}
  } catch {
    return null // inaccessible: start a new one
  }
}

// Redis has no summary for this thread, but the app's account may already have one there: the Python
// bot's summaries, once Reddit moves u/GGGCommentBot to the app, or ours from before a reinstall.
// Continuing it keeps one summary per thread.
async function adopt({reddit}: Deps, postId: string): Promise<Summary | null> {
  let chain: CommentLike[]
  try {
    chain = await reddit.findOwnSummary(postId)
  } catch {
    return null
  }
  if (!chain.length || chain.some(isGone)) return null
  console.log(`adopted the summary already in ${postId}; comments=${chain.length} latest=${chain.at(-1)!.id}`)
  return {latest: chain.at(-1)!, bodies: chain.map(c => c.body)}
}

// Lines link to the comment, so its id in a summary means the comment is already listed.
const listedIn = (bodies: string[], commentId: string) => {
  const needle = `/${commentId.replace(/^t1_/, '')}/`
  return bodies.some(b => b.includes(needle))
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
    const summary = await findAggregation(deps, c.postId)
    const existing = summary?.latest
    if (summary && listedIn(summary.bodies, c.id)) {
      await redis.set(aggKey(c.postId), summary.latest.id)
      await redis.expire(aggKey(c.postId), AGG_TTL_S)
      await markSeen(redis, c.id)
      return false
    }
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
    await markSeen(redis, c.id)
    return true
  })
}

async function markSeen(redis: Deps['redis'], commentId: string) {
  await redis.set(seenKey(commentId), '1')
  await redis.expire(seenKey(commentId), SEEN_TTL_S)
}

// Safety net for triggers that never arrived: look at each employee's own recent comments.
export async function sweep(): Promise<{checked: number; added: number; waiting?: true}> {
  if (!(await mayPost())) return {checked: 0, added: 0, waiting: true}
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
