import type {IncomingMessage, ServerResponse} from 'node:http'
import {createServer, getServerPort} from '@devvit/web/server'
import type {OnCommentCreateRequest, OnPostSubmitRequest} from '@devvit/web/shared'
import {isEmployee} from '../shared/aggregate.ts'
import {aggregate, loadRoster, logTrackError, mayPost, sweep} from './aggregator.ts'
import {trackComment, trackPost} from './tracker.ts'

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // The Devvit trigger wrapper rejects responses without a Content-Length.
  const text = JSON.stringify(body)
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(text)})
  res.end(text)
}

async function onCommentCreate(req: IncomingMessage): Promise<unknown> {
  const event = (await readJson(req)) as OnCommentCreateRequest
  const c = event.comment
  console.log(`comment-create; id=${c?.id} author=${event.author?.name} postId=${c?.postId} keys=${Object.keys(event).join(',')}`)
  if (!c) return {status: 'ignored'}
  // Cheap exit for the vast majority of comments, before any Reddit or Redis calls.
  const roster = await loadRoster()
  const author = event.author?.name ?? c.author
  if (!isEmployee(author, roster)) return {status: 'skipped'}
  const tracked = await trackComment(c.id).catch(logTrackError(c.id))
  if (tracked) console.log(`tracker; posted ${c.id}`)
  if (!(await mayPost())) return {status: 'waiting'}
  const added = await aggregate(
    {id: c.id, author, body: c.body, permalink: c.permalink, postId: c.postId, createdAtMs: c.createdAt},
    roster,
  )
  console.log(`comment-create; roster=${roster.size} result=${added ? 'aggregated' : 'skipped'}`)
  return {status: added ? 'aggregated' : 'skipped'}
}

async function onPostSubmit(req: IncomingMessage): Promise<unknown> {
  const event = (await readJson(req)) as OnPostSubmitRequest
  const p = event.post
  if (!p) return {status: 'ignored'}
  const roster = await loadRoster()
  if (!isEmployee(event.author?.name, roster)) return {status: 'skipped'}
  const tracked = await trackPost(p.id).catch(logTrackError(p.id))
  console.log(`post-submit; id=${p.id} author=${event.author?.name} tracked=${tracked}`)
  return {status: tracked ? 'tracked' : 'skipped'}
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      console.error(`unexpected request; ${req.method} ${req.url}`)
      return send(res, 404, {error: 'not found'})
    }
    switch (req.url) {
      case '/internal/triggers/on-comment-create':
        return send(res, 200, await onCommentCreate(req))
      case '/internal/triggers/on-post-submit':
        return send(res, 200, await onPostSubmit(req))
      case '/internal/jobs/sweep':
      {
        const result = await sweep()
        console.log(`sweep; result=${JSON.stringify(result)}`)
        return send(res, 200, result)
      }
      default:
        console.error(`unexpected request; ${req.method} ${req.url}`)
        return send(res, 404, {error: 'not found'})
    }
  } catch (err) {
    console.error(`server error; ${err instanceof Error ? err.stack : err}`)
    send(res, 500, {error: 'internal error'})
  }
})

server.on('error', err => console.error(`server error; ${err.stack}`))
server.listen(getServerPort())
