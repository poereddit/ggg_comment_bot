// Pure logic for the GGG Comment Bot, ported from GGGRedditBot.py.
// No Devvit imports here so it can be tested with plain `node --test`.

export const SNIPPET_WORDS = 30
export const CONTEXT_DEPTH = 10
// A bot comment longer than this is treated as full and the next line goes in a reply to it.
export const BODY_LIMIT = 7200

export const HEADER = '##### GGG Comments in this Thread:\n\n***'
export const FOOTER =
  '\n\n Normally, I would break here due to too many replies, but this bot is now Bex Proof! Continued below...'

// Embedded media (![gif](giphy|..), uploaded images, emotes) is rejected by Reddit when nested in a
// bot comment, so it is replaced before the snippet is cut.
export function createSnippet(body: string, wordCount: number = SNIPPET_WORDS): string {
  const cleaned = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '(gif)')
  const words = cleaned.split(/\s+/).filter(w => w.length > 0)
  let snippet = words.slice(0, wordCount).join(' ')
  if (words.length > wordCount) snippet += '...'
  return snippet || '(gif)'
}

export type LineInput = {
  author: string
  permalink: string // path only, e.g. /r/pathofexile/comments/abc/title/def/
  snippet: string
  contextDepth?: number
}

export function formatLine({author, permalink, snippet, contextDepth = CONTEXT_DEPTH}: LineInput): string {
  const q = `?context=${contextDepth}`
  return `\n\n[${author} - [link](https://www.reddit.com${permalink}${q}), [old](https://old.reddit.com${permalink}${q})] - *${snippet}*\n\n`
}

export type Plan =
  | {kind: 'create'; body: string}
  | {kind: 'edit'; body: string}
  // The previous bot comment is full: optionally add the footer to it, then reply to it.
  | {kind: 'chain'; footerEdit: string | null; replyBody: string}

export function planAppend(existingBody: string | null, line: string): Plan {
  if (existingBody === null) return {kind: 'create', body: HEADER + line}
  if (existingBody.length <= BODY_LIMIT) return {kind: 'edit', body: existingBody + line}
  return {
    kind: 'chain',
    footerEdit: existingBody.includes(FOOTER) ? null : existingBody + FOOTER,
    replyBody: HEADER + line,
  }
}

// Mod-editable roster: one username per line (commas also work), optional u/ prefix, # comments.
export function parseRoster(text: string): Set<string> {
  const names = new Set<string>()
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.replace(/#.*/, '').trim().replace(/^\/?u\//i, '')
    if (line) names.add(line.toLowerCase())
  }
  return names
}

export function isEmployee(author: string | undefined | null, roster: Set<string>): boolean {
  return !!author && roster.has(author.toLowerCase())
}

// Seed list copied from the Python bot (needs a refresh from the mods before cutover).
export const DEFAULT_ROSTER = [
  'Kelly_GGG', 'Community_Team', 'chris_wilson', 'Bex_GGG', 'Negitivefrags', 'Rory_Rackham',
  'Omnitect', 'Mark_GGG', 'Daniel_GGG', 'Blake_GGG', 'RhysGGG', 'Dan_GGG', 'pantherNZ',
  'AlexDenfordGGG', 'M59Gar', 'Novynn', 'Fitzy_GGG', 'Hrishi_GGG', 'Felipe_GGG', 'Mel_GGG',
  'Sarah_GGG', 'riandrake', 'Kieren_GGG', 'Hartlin_GGG', 'Baltic_GGG', 'KamilOrmanJanowski',
  'Jeff_GGG', 'Stacey_GGG', 'Openarl', 'Natalia_GGG', 'Natalia2_GGG', 'viperesque', 'ZaccieA',
  'Henry_GGG', 'Nick_GGG', 'Neon_GGG', 'Belakay_ggg', 'MatthewD_GGG',
].join('\n')

// The sweep only picks up comments from the last day, so installing the app never
// back-fills old threads. (The Python bot seeded a baseline on first run instead.)
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function isFresh(createdAtMs: number, nowMs: number, maxAgeMs: number = MAX_AGE_MS): boolean {
  return nowMs - createdAtMs <= maxAgeMs
}
