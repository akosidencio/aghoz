/**
 * A tiny application with the publication boundary wired correctly.
 *
 *   node server.mjs        # then: curl -N http://127.0.0.1:3412/events?topics=orders
 *
 * Plain `node:http` and `node:sqlite`, no third-party dependencies, so the only thing
 * on show is the boundary: writes go through `withOutbox`, a relay publishes, and the
 * stream is an ordinary aghoz mount.
 */

import { createServer } from 'node:http'
import { createHub, validOrigin } from '@aghoz/server'
import { openDatabase, withOutbox, createRelay } from './outbox.mjs'

const PORT = Number(process.env.PORT ?? 3412)
const db = openDatabase(process.env.DB_PATH ?? ':memory:')
const hub = createHub()
const relay = createRelay({ db, hub, onError: (error) => console.error('relay:', error) })
relay.start()

const stream = hub.handler({})

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => respondWithError(res, error))
})

async function handle(req, res) {
  // Only the path and query are used. Building the base from the untrusted Host header
  // lets a malformed Host turn URL parsing into a remotely-triggered exception.
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/events') return stream(req, res)

  if (url.pathname === '/api/orders' && req.method === 'GET') {
    const rows = db.prepare('SELECT id, title, cents FROM orders ORDER BY id').all()
    // §5 — the cursor, read at the same moment as the data. Without it, anything
    // published between this response and the browser opening its stream is lost with
    // nothing reported, on every first page load.
    res.writeHead(200, { 'content-type': 'application/json', 'event-cursor': hub.cursor() })
    return res.end(JSON.stringify(rows))
  }

  if (url.pathname === '/api/orders' && req.method === 'POST') {
    const body = await readJson(req)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError(400, 'body must be a JSON object')
    }
    const origin = requestOrigin(req)
    const title = String(body.title ?? 'untitled')
    const cents = Number(body.cents ?? 0)
    if (!Number.isSafeInteger(cents)) {
      throw new RequestError(400, 'cents must be a safe integer')
    }
    const order = withOutbox(db, (emit) => {
      const info = db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run(
        title,
        cents,
      )
      const id = Number(info.lastInsertRowid)
      // Written to the outbox inside the same transaction as the row above. If the
      // process dies at any point from here to the relay's next pass, the event is
      // still on disk and still goes out.
      // §6.0 — the writing tab sends its `client.originId`, and it travels through the
      // outbox so the echo can be skipped in the one tab that already has the answer.
      emit('orders', { id, title, cents }, origin)
      return { id }
    })

    // Answered without waiting for the relay. The write's own response is what the
    // calling tab renders; the stream is for every *other* tab. Blocking here would
    // make an outbox as slow as publishing inline, and buy nothing.
    res.writeHead(201, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(order))
  }

  res.writeHead(404).end()
}

server.listen(PORT, () => {
  console.log(`outbox example on http://127.0.0.1:${PORT}`)
})

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 1_000_000) {
        settled = true
        body = ''
        // Keep draining the socket, but retain no more attacker-controlled bytes.
        reject(new RequestError(413, 'body too large'))
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(body === '' ? {} : JSON.parse(body))
      } catch (error) {
        reject(new RequestError(400, 'body must be valid JSON', { cause: error }))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function requestOrigin(req) {
  const origin = req.headers['x-origin']
  if (origin === undefined) return undefined
  if (Array.isArray(origin) || !validOrigin(origin)) {
    throw new RequestError(400, 'x-origin must be a 1-64 byte token without control characters')
  }
  return origin
}

class RequestError extends Error {
  constructor(status, message, options) {
    super(message, options)
    this.status = status
  }
}

function respondWithError(res, error) {
  const expected = error instanceof RequestError
  const status = expected ? error.status : 500
  if (!expected) console.error('request:', error)
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined)
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    // A rejected oversized body may still be arriving; do not reuse that connection.
    connection: 'close',
  })
  res.end(JSON.stringify({ error: expected ? error.message : 'internal server error' }))
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    relay.stop()
    hub.close()
    server.close(() => process.exit(0))
  })
}
