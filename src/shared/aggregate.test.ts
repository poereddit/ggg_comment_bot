import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  BODY_LIMIT, DEFAULT_ROSTER, FOOTER, HEADER, createSnippet, formatLine, isEmployee, isFresh, parseRoster, planAppend,
} from './aggregate.ts'

test('snippet keeps short comments whole', () => {
  assert.equal(createSnippet('Thanks   for the\nfeedback'), 'Thanks for the feedback')
})

test('snippet cuts at 30 words and adds an ellipsis only when words were dropped', () => {
  const thirty = Array.from({length: 30}, (_, i) => `w${i}`).join(' ')
  assert.equal(createSnippet(thirty), thirty)
  assert.equal(createSnippet(thirty + ' extra'), thirty + '...')
})

test('snippet replaces embedded media and never returns empty', () => {
  assert.equal(createSnippet('![gif](giphy|abc123)'), '(gif)')
  assert.equal(createSnippet('nice ![img](https://i.redd.it/x.png) one'), 'nice (gif) one')
  assert.equal(createSnippet('   \n '), '(gif)')
})

test('line format matches the Python bot', () => {
  assert.equal(
    formatLine({author: 'Carol_GGG', permalink: '/r/pathofexile/comments/a/t/b/', snippet: 'Hi'}),
    '\n\n[Carol_GGG - [link](https://www.reddit.com/r/pathofexile/comments/a/t/b/?context=10), [old](https://old.reddit.com/r/pathofexile/comments/a/t/b/?context=10)] - *Hi*\n\n',
  )
})

test('first GGG comment creates the header comment', () => {
  assert.deepEqual(planAppend(null, 'L'), {kind: 'create', body: HEADER + 'L'})
})

test('later comments edit the existing one', () => {
  assert.deepEqual(planAppend('body', 'L'), {kind: 'edit', body: 'bodyL'})
  const atLimit = 'x'.repeat(BODY_LIMIT)
  assert.equal(planAppend(atLimit, 'L').kind, 'edit')
})

test('a full comment gets the footer once, then new lines chain below it', () => {
  const full = 'x'.repeat(BODY_LIMIT + 1)
  assert.deepEqual(planAppend(full, 'L'), {kind: 'chain', footerEdit: full + FOOTER, replyBody: HEADER + 'L'})
  assert.deepEqual(planAppend(full + FOOTER, 'L'), {kind: 'chain', footerEdit: null, replyBody: HEADER + 'L'})
})

test('roster parsing handles prefixes, commas, comments and case', () => {
  const r = parseRoster('Kelly_GGG\nu/Bex_GGG, /u/Mark_GGG  # staff\n\n# gone\nNovynn')
  assert.deepEqual([...r].sort(), ['bex_ggg', 'kelly_ggg', 'mark_ggg', 'novynn'])
  assert.equal(isEmployee('BEX_ggg', r), true)
  assert.equal(isEmployee('someone', r), false)
  assert.equal(isEmployee(undefined, r), false)
})

test('devvit.json default roster matches the seed list', async () => {
  const {readFileSync} = await import('node:fs')
  const cfg = JSON.parse(readFileSync(new URL('../../devvit.json', import.meta.url), 'utf8'))
  assert.equal(cfg.settings.subreddit.roster.defaultValue, DEFAULT_ROSTER)
})

test('only the last day of employee comments is swept', () => {
  const now = 10 * 24 * 3600 * 1000
  assert.equal(isFresh(now - 3600_000, now), true)
  assert.equal(isFresh(now - 25 * 3600_000, now), false)
})
