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
import { createHub } from '@aghoz/server'
import { openDatabase, withOutbox, createRelay } from './outbox.mjs'

const PORT = Number(process.env.PORT ?? 3412)
const db = openDatabase(process.env.DB_PATH ?? ':memory:')
const hub = createHub()
const relay = createRelay({ db, hub, onError: (error) => console.error('relay:', error) })
relay.start()

const stream = hub.handler({})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

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
    const order = withOutbox(db, (emit) => {
      const info = db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run(
        String(body.title ?? 'untitled'),
        Number(body.cents ?? 0),
      )
      const id = Number(info.lastInsertRowid)
      // Written to the outbox inside the same transaction as the row above. If the
      // process dies at any point from here to the relay's next pass, the event is
      // still on disk and still goes out.
      // §6.0 — the writing tab sends its `client.originId`, and it travels through the
      // outbox so the echo can be skipped in the one tab that already has the answer.
      emit('orders', { id, title: body.title, cents: body.cents }, req.headers['x-origin'])
      return { id }
    })

    // Answered without waiting for the relay. The write's own response is what the
    // calling tab renders; the stream is for every *other* tab. Blocking here would
    // make an outbox as slow as publishing inline, and buy nothing.
    res.writeHead(201, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(order))
  }

  res.writeHead(404).end()
})

server.listen(PORT, () => {
  console.log(`outbox example on http://127.0.0.1:${PORT}`)
})

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(body === '' ? {} : JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    relay.stop()
    hub.close()
    server.close(() => process.exit(0))
  })
}
