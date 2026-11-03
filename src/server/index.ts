import type {IncomingMessage, ServerResponse} from 'node:http'
import {createServer, getServerPort, scheduler} from '@devvit/web/server'
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

// The cron job is created here instead of in devvit.json: a cron entry in the config made installs
// fail ("No context found" during OnAppInstall) on devvit 0.14.2.
const SWEEP_CRON = '*/10 * * * *'
async function onAppInstall(): Promise<unknown> {
  const jobs = await scheduler.listJobs()
  if (!jobs.some(j => j.name === 'sweep' && 'cron' in j)) {
    await scheduler.runJob({name: 'sweep', cron: SWEEP_CRON})
  }
  return {status: 'ok'}
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return send(res, 404, {error: 'not found'})
    switch (req.url) {
      case '/internal/triggers/on-comment-create':
        return send(res, 200, await onCommentCreate(req))
      case '/internal/on/app/install':
        return send(res, 200, await onAppInstall())
      case '/internal/jobs/sweep':
        return send(res, 200, await sweep())
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
