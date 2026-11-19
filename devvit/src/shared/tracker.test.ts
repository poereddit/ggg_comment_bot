import assert from 'node:assert/strict'
import {test} from 'node:test'
import {commentEmbed, postEmbed, truncate} from './tracker.ts'

test('a comment embed matches the old tracker format', () => {
  const e = commentEmbed({
    author: 'Carol_GGG', subreddit: 'pathofexile', permalink: '/r/pathofexile/comments/p1/t/c1/',
    body: 'We hear you &amp; a fix is coming', postTitle: 'Nobody gave Carol a color',
    postPermalink: '/r/pathofexile/comments/p1/t/', createdAtMs: 0,
  })
  assert.equal(e.author.name, '/u/Carol_GGG commented in r/PathOfExile')
  assert.equal(e.title, 'Nobody gave Carol a color')
  assert.ok(e.description!.startsWith('We hear you & a fix is coming\n\n[In context](https://www.reddit.com/r/pathofexile/comments/p1/t/c1/?context=8)'))
  assert.equal(e.color, 10355716)
})

test('an image post shows the image, a link post shows the link', () => {
  const base = {author: 'Bex_GGG', subreddit: 'PathOfExile2', permalink: '/r/PathOfExile2/comments/p2/x/', title: 'Patch notes', isSelf: false, createdAtMs: 0}
  const img = postEmbed({...base, url: 'https://i.redd.it/a.png'})
  assert.equal(img.image?.url, 'https://i.redd.it/a.png')
  assert.equal(img.description, undefined)
  const link = postEmbed({...base, url: 'https://www.pathofexile.com/forum/view-thread/1'})
  assert.equal(link.description, 'https://www.pathofexile.com/forum/view-thread/1')
  assert.equal(link.author.name, '/u/Bex_GGG posted in r/PathOfExile2')
})

test('long text is cut at a word', () => {
  assert.equal(truncate('aaa bbb ccc', 6), 'aaa…')
})
