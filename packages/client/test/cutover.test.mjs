// §9.3 topic-set cutover, and §9.2 handler failure — over a real socket.
//
// `conformance/client/vectors.json` pins the rule as a pure function; this pins that the
// client actually reaches it from real reconnects, and that the hole §9.3 describes is a
// real hole rather than a story about one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '@aghoz/server'
import { createClient } from '../dist/index.js'

async function boot({ hubOptions = {} } = {}) {
  const hub = createHub({ keepAliveMs: 0, ...hubOptions })
  const handler = hub.handler({})
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] === '/events') return handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, r))
  return {
    hub,
    url: `http://127.0.0.1:${server.address().port}/events`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

async function until(predicate, ms = 2000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ------------------------------------------------------------------- §9.3 cutover

test('a topic added after the cursor moved is reported as a cutover, once its stream is open', async () => {
  const s = await boot()
  const cutovers = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onCutover: (topics) => cutovers.push([...topics]),
  })
  try {
    const a = []
    const b = []
    client.subscribe('a', (data) => a.push(data))
    await until(() => client.state === 'open', 2000, 'first open')
    assert.deepEqual(cutovers, [], 'the page-load topic set shares the initial cursor')

    // The §9.3 interleaving, in the order it happens in production: an event for a
    // topic nobody is watching yet, then an event for a watched topic that carries the
    // cursor past it.
    await s.hub.publish('b', { n: 11 })
    await s.hub.publish('a', { n: 12 })
    await until(() => a.length === 1, 2000, 'a delivered')

    const openState = client.state
    assert.equal(openState, 'open')

    client.subscribe('b', (data) => b.push(data))
    await until(() => cutovers.length === 1, 2000, 'cutover reported')

    assert.deepEqual(cutovers[0], ['b'], 'only the topic without a baseline')
    assert.equal(client.state, 'open', 'reported after the replacement stream is open')
    // The hole is real: b's earlier event is not replayed and no gap was reported, which
    // is exactly why the cutover has to be reported instead.
    assert.deepEqual(b, [], 'the pre-subscription event is gone, silently')
  } finally {
    client.close()
    await s.close()
  }
})

test('a lazily added topic before any event shares the page baseline and reports nothing', async () => {
  const s = await boot()
  const cutovers = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onCutover: (topics) => cutovers.push([...topics]),
  })
  try {
    client.subscribe('a', () => {})
    await until(() => client.state === 'open', 2000, 'open')
    client.subscribe('b', () => {})
    await until(() => client.connectionCount === 2, 2000, 'reconnect for the new set')
    await tick(80)
    assert.deepEqual(cutovers, [], 'no refetch storm on a first page load')
  } finally {
    client.close()
    await s.close()
  }
})

test('reconnecting the same topic set is not a cutover', async () => {
  const s = await boot()
  const cutovers = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    baseBackoffMs: 20,
    initialCursor: s.hub.cursor(),
    onCutover: (topics) => cutovers.push([...topics]),
  })
  try {
    const seen = []
    client.subscribe('a', (data) => seen.push(data))
    await until(() => client.state === 'open', 2000, 'open')
    await s.hub.publish('a', { n: 1 })
    await until(() => seen.length === 1, 2000, 'delivery')

    s.hub.disconnect(() => true)
    await until(() => client.connectionCount === 2, 3000, 'reconnect')
    await tick(80)
    assert.deepEqual(cutovers, [], 'the cursor already covers this set')
  } finally {
    client.close()
    await s.close()
  }
})

test('a cutover listener registered by an adapter fires alongside the option', async () => {
  const s = await boot()
  const fromOption = []
  const fromListener = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onCutover: (topics) => fromOption.push([...topics]),
  })
  const off = client.onCutover((topics) => fromListener.push([...topics]))
  try {
    const seen = []
    client.subscribe('a', (data) => seen.push(data))
    await until(() => client.state === 'open', 2000, 'open')
    await s.hub.publish('a', { n: 1 })
    await until(() => seen.length === 1, 2000, 'cursor advanced')

    client.subscribe('b', () => {})
    await until(() => fromListener.length === 1, 2000, 'listener')
    assert.deepEqual(fromOption, [['b']])
    assert.deepEqual(fromListener, [['b']])

    off()
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------- §9.2 handler failure

test('a throwing handler is reported with the topic it was for, and the cursor is past it', async () => {
  const s = await boot()
  const failures = []
  const errors = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onHandlerError: (error, meta) => failures.push({ error, meta }),
    onError: (error) => errors.push(error),
  })
  try {
    const seen = []
    client.subscribe('orders', (raw) => {
      const parsed = JSON.parse(raw)
      if (parsed.n === 1) throw new Error('fold failed')
      seen.push(parsed.n)
    })
    await until(() => client.state === 'open', 2000, 'open')

    await s.hub.publish('orders', { n: 1 })
    await until(() => failures.length === 1, 2000, 'handler failure reported')

    assert.equal(failures[0].meta.topic, 'orders', 'the topic is what a cache needs')
    assert.equal(failures[0].error.message, 'fold failed')
    assert.equal(client.cursor, failures[0].meta.id, 'the cursor is already past it')
    assert.equal(errors.length, 1, 'still an ordinary error for existing logging')

    // The connection is unaffected — one component must not stall the others.
    await s.hub.publish('orders', { n: 2 })
    await until(() => seen.length === 1, 2000, 'delivery continues')
    assert.equal(client.state, 'open')
  } finally {
    client.close()
    await s.close()
  }
})

test('a handler-error listener registered by an adapter fires alongside the option', async () => {
  const s = await boot()
  const seen = []
  const client = createClient({ url: s.url, debounceMs: 20, initialCursor: s.hub.cursor() })
  const off = client.onHandlerError((_error, meta) => seen.push(meta.topic))
  try {
    client.subscribe('t', () => {
      throw new Error('nope')
    })
    await until(() => client.state === 'open', 2000, 'open')
    await s.hub.publish('t', { n: 1 })
    await until(() => seen.length === 1, 2000, 'listener')
    assert.deepEqual(seen, ['t'])
    off()
  } finally {
    client.close()
    await s.close()
  }
})

test('a rejected async handler is reported without becoming an unhandled rejection', async () => {
  const s = await boot()
  const failures = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onHandlerError: (error, meta) => failures.push({ error, meta }),
  })
  try {
    client.subscribe('t', async () => {
      throw new Error('async fold failed')
    })
    await until(() => client.state === 'open', 2000, 'open')
    await s.hub.publish('t', { n: 1 })
    await until(() => failures.length === 1, 2000, 'async handler failure')

    assert.equal(failures[0].error.message, 'async fold failed')
    assert.equal(failures[0].meta.topic, 't')
    assert.equal(client.cursor, failures[0].meta.id, 'the async failure names the spent event')
    assert.equal(client.state, 'open', 'a rejected handler does not tear down the stream')
  } finally {
    client.close()
    await s.close()
  }
})

test('a throwing handler-error option cannot suppress registered recovery listeners', async () => {
  const s = await boot()
  const recovered = []
  const errors = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onHandlerError: () => {
      throw new Error('observer failed')
    },
    onError: (error) => errors.push(error.message),
  })
  client.onHandlerError((_error, meta) => recovered.push(meta.topic))
  try {
    client.subscribe('t', () => {
      throw new Error('handler failed')
    })
    await until(() => client.state === 'open', 2000, 'open')
    await s.hub.publish('t', { n: 1 })
    await until(() => recovered.length === 1, 2000, 'recovery listener')

    assert.deepEqual(recovered, ['t'])
    assert.deepEqual(errors, ['observer failed', 'handler failed'])
    assert.equal(client.state, 'open')
  } finally {
    client.close()
    await s.close()
  }
})

test('a throwing cutover option cannot consume the signal before adapter listeners run', async () => {
  const s = await boot()
  const recovered = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    initialCursor: s.hub.cursor(),
    onCutover: () => {
      throw new Error('observer failed')
    },
  })
  client.onCutover((topics) => recovered.push([...topics]))
  try {
    client.subscribe('a', () => {})
    await until(() => client.state === 'open', 2000, 'open')
    const published = await s.hub.publish('a', { n: 1 })
    await until(() => client.cursor === published.id, 2000, 'cursor advance')
    client.subscribe('b', () => {})
    await until(() => recovered.length === 1, 2000, 'cutover recovery listener')

    assert.deepEqual(recovered, [['b']])
    assert.equal(client.state, 'open')
  } finally {
    client.close()
    await s.close()
  }
})
