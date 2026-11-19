// Discord embeds for #ggg-tracker, in the format the Python relay (and MonitoRSS before it) used.
// No Devvit imports, so it can be tested with plain `node --test`.

export const COLOR = 10355716
export const BODY_LIMIT = 1800
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

const SUBS: Record<string, {label: string; icon: string}> = {
  pathofexile: {label: 'PathOfExile', icon: 'https://i.imgur.com/tpZbfh0.png'},
  pathofexile2: {label: 'PathOfExile2', icon: 'https://i.imgur.com/m4N6SnK.png'},
}

const subMeta = (name: string) =>
  SUBS[name.toLowerCase()] ?? {label: name, icon: 'https://www.redditstatic.com/icon.png'}

export function truncate(text: string | undefined, limit = BODY_LIMIT): string {
  const t = (text ?? '').trim()
  if (t.length <= limit) return t
  const cut = t.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut) + '…'
}

export function cleanMarkdown(text: string | undefined): string {
  return (text ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, '$1') // reddit inline media -> bare link
    .replace(/&#x200B;/g, '')
}

const isImage = (url: string | undefined) => !!url && /\.(png|jpe?g|gif|webp)$/i.test(url.split('?')[0]!)

export type Embed = {
  author: {name: string; url: string; icon_url: string}
  title: string
  url: string
  description?: string
  color: number
  timestamp: string
  image?: {url: string}
}

export type CommentItem = {
  author: string
  subreddit: string
  permalink: string // path, e.g. /r/pathofexile/comments/abc/title/def/
  body: string
  postTitle: string
  postPermalink: string
  createdAtMs: number
}

export function commentEmbed(c: CommentItem): Embed {
  const meta = subMeta(c.subreddit)
  const link = 'https://www.reddit.com' + c.permalink
  const thread = 'https://www.reddit.com' + c.postPermalink
  const body = truncate(cleanMarkdown(c.body))
  return {
    author: {name: `/u/${c.author} commented in r/${meta.label}`, url: link, icon_url: meta.icon},
    title: truncate(c.postTitle, 250),
    url: link,
    description: `${body}\n\n[In context](${link}?context=8) · [Full thread](${thread})`,
    color: COLOR,
    timestamp: new Date(c.createdAtMs).toISOString(),
  }
}

export type PostItem = {
  author: string
  subreddit: string
  permalink: string
  title: string
  body?: string | undefined
  url?: string | undefined
  isSelf: boolean
  createdAtMs: number
}

export function postEmbed(p: PostItem): Embed {
  const meta = subMeta(p.subreddit)
  const link = 'https://www.reddit.com' + p.permalink
  const embed: Embed = {
    author: {name: `/u/${p.author} posted in r/${meta.label}`, url: link, icon_url: meta.icon},
    title: truncate(p.title, 250),
    url: link,
    color: COLOR,
    timestamp: new Date(p.createdAtMs).toISOString(),
  }
  const image = !p.isSelf && isImage(p.url) ? p.url : undefined
  const desc = p.body ? truncate(cleanMarkdown(p.body)) : p.isSelf || image ? '' : p.url ?? ''
  if (desc) embed.description = desc
  if (image) embed.image = {url: image}
  return embed
}

export const isFresh = (createdAtMs: number, nowMs: number) => nowMs - createdAtMs <= MAX_AGE_MS
