import {context, reddit as realReddit, redis as realRedis, settings} from '@devvit/web/server'
import {type Embed, commentEmbed, isFresh, postEmbed} from '../shared/tracker.ts'

// Posts each GGG employee comment and post to #ggg-tracker through a Discord webhook. Runs
// whatever the onlyAs gate says: it only reads Reddit, so it doesn't wait for the account name.

const SENT_TTL_S = 7 * 24 * 60 * 60
const sentKey = (id: string) => `tracked:${id}`
const SINCE_KEY = 'tracker:since'

export type TrackerDeps = {
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<unknown>
    expire(key: string, seconds: number): Promise<unknown>
    incrBy(key: string, value: number): Promise<number>
    del(key: string): Promise<unknown>
  }
  webhook(): Promise<string | undefined>
  enabled(): Promise<boolean>
  send(url: string, body: unknown): Promise<{ok: boolean; status: number; retryAfterS?: number}>
}

const realDeps: TrackerDeps = {
  redis: realRedis as unknown as TrackerDeps['redis'],
  webhook: async () => ((await settings.get<string>('trackerWebhook')) ?? '').trim() || undefined,
  enabled: async () => (await settings.get<boolean>('trackerOn')) === true,
  async send(url, body) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    })
    let retryAfterS: number | undefined
    if (res.status === 429) retryAfterS = ((await res.json().catch(() => ({}))) as {retry_after?: number}).retry_after
    return {ok: res.ok, status: res.status, retryAfterS}
  },
}

// Returns true if the embed was posted now. A claim key stops the trigger and the sweep from
// posting the same item twice; it's released when the send fails so the next sweep retries.
export async function track(id: string, createdAtMs: number, embed: () => Promise<Embed>, deps: TrackerDeps = realDeps): Promise<boolean> {
  if (!isFresh(createdAtMs, Date.now())) return false
  if (!(await deps.enabled())) return false
  const url = await deps.webhook()
  if (!url) return false
  // Items from before the tracker was first turned on in this subreddit were already posted
  // by the old relay, so only newer ones go out.
  const since = Number(await deps.redis.get(SINCE_KEY)) || 0
  if (!since) {
    await deps.redis.set(SINCE_KEY, String(Date.now()))
    return false
  }
  if (createdAtMs < since) return false
  const key = sentKey(id)
  if ((await deps.redis.incrBy(key, 1)) !== 1) return false
  await deps.redis.expire(key, SENT_TTL_S)
  try {
    const res = await deps.send(url, {
      username: 'GGG Tracker',
      embeds: [await embed()],
      allowed_mentions: {parse: []},
    })
    if (!res.ok) throw new Error(`discord ${res.status}${res.retryAfterS ? ` retry_after=${res.retryAfterS}` : ''}`)
    return true
  } catch (err) {
    await deps.redis.del(key)
    throw err
  }
}

export async function trackComment(commentId: string): Promise<boolean> {
  const c = await realReddit.getCommentById(commentId as `t1_${string}`)
  return track(c.id, c.createdAt.getTime(), async () => {
    const post = await realReddit.getPostById(c.postId)
    return commentEmbed({
      author: c.authorName, subreddit: c.subredditName, permalink: c.permalink, body: c.body,
      postTitle: post.title, postPermalink: post.permalink, createdAtMs: c.createdAt.getTime(),
    })
  })
}

export async function trackPost(postId: string): Promise<boolean> {
  const p = await realReddit.getPostById(postId as `t3_${string}`)
  const isSelf = p.url.includes(p.permalink) || p.url.includes('/comments/')
  return track(p.id, p.createdAt.getTime(), async () =>
    postEmbed({
      author: p.authorName, subreddit: p.subredditName || context.subredditName, permalink: p.permalink,
      title: p.title, body: p.body, url: p.url, isSelf, createdAtMs: p.createdAt.getTime(),
    }),
  )
}
