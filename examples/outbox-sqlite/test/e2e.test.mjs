// The same boundary over a real socket, from a write to a subscriber's frame.
//
// `outbox.test.mjs` pins the relay; this pins that the whole path is wired — a POST
// that commits, a relay that publishes, and a stream that delivers it — because every
// production failure in this project has been in the wiring rather than in the logic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const PORT = 3413
const BASE = `http://127.0.0.1:${PORT}`

test('a committed write reaches a subscriber through the outbox', async (t) => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  t.after(async () => {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => {})
  })

  // Wait for the port rather than for a log line, so a change in wording cannot turn
  // this into a sleep.
  let cursor
  for (let i = 0; i < 100 && cursor === undefined; i++) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      const res = await fetch(`${BASE}/api/orders`)
      if (res.ok) cursor = res.headers.get('event-cursor')
    } catch {
      // not listening yet
    }
  }
  assert.ok(cursor, `server did not start\n${log}`)

  const malformed = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400, 'bad JSON is a request error, not a process crash')

  const oversized = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x'.repeat(1_000_000), cents: 1 }),
  })
  assert.equal(oversized.status, 413, 'oversized bodies are rejected without being retained')

  const poisoned = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-origin': 'x'.repeat(65) },
    body: JSON.stringify({ title: 'must not commit', cents: 1 }),
  })
  assert.equal(poisoned.status, 400, 'an origin the hub will reject never enters the outbox')

  const afterRejections = await fetch(`${BASE}/api/orders`)
  assert.equal(afterRejections.status, 200, 'the server remains alive after rejected input')
  assert.deepEqual(await afterRejections.json(), [], 'the poisoned mutation rolled back entirely')

  // §5 — the stream opens from the cursor the data was read at, so the order placed
  // below cannot slip through the gap between the two.
  const stream = await fetch(`${BASE}/events?topics=orders&last_event_id=${cursor}`, {
    headers: { accept: 'text/event-stream' },
  })
  assert.equal(stream.status, 200)

  const post = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'a book', cents: 1200 }),
  })
  assert.equal(post.status, 201)

  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5000
  while (!buffer.includes('a book') && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})

  assert.match(buffer, /event: orders/, `no frame arrived\n${buffer}\n${log}`)
  assert.match(buffer, /"title":"a book"/)
})
