import type {IncomingMessage, ServerResponse} from 'node:http'
import {createServer, getServerPort} from '@devvit/web/server'
import type {OnCommentCreateRequest} from '@devvit/web/shared'
import {aggregate, loadRoster, sweep} from './aggregator.ts'

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
  const added = await aggregate(
    {id: c.id, author: event.author?.name ?? c.author, body: c.body, permalink: c.permalink, postId: c.postId, createdAtMs: c.createdAt},
    roster,
  )
  console.log(`comment-create; roster=${roster.size} result=${added ? 'aggregated' : 'skipped'}`)
  return {status: added ? 'aggregated' : 'skipped'}
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return send(res, 404, {error: 'not found'})
    switch (req.url) {
      case '/internal/triggers/on-comment-create':
        return send(res, 200, await onCommentCreate(req))
      case '/internal/jobs/sweep':
      {
        const result = await sweep()
        console.log(`sweep; result=${JSON.stringify(result)}`)
        return send(res, 200, result)
      }
      default:
        return send(res, 404, {error: 'not found'})
    }
  } catch (err) {
    console.error(`server error; ${err instanceof Error ? err.stack : err}`)
    send(res, 500, {error: 'internal error'})
  }
})

server.on('error', err => console.error(`server error; ${err.stack}`))
server.listen(getServerPort())
