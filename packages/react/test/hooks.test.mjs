// React binding tests — R1 to R4, plus the connection-reuse claim.
// Runs against a real hub over a real socket, in jsdom.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { JSDOM } from 'jsdom'
import { createHub } from '@aghoz/server'

// jsdom must exist before React or Testing Library is imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 22 exposes navigator as a getter-only global, so plain assignment throws.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { render, cleanup, waitFor, act } = await import('@testing-library/react')
const { AghozProvider, useTopic, useTopicEffect, useTopicReducer, useAghoz } =
  await import('../dist/index.js')
const { createClient } = await import('@aghoz/client')

const h = React.createElement

let hub
let server
let url

before(async () => {
  hub = createHub({ keepAliveMs: 0 })
  const handler = hub.handler({})
  server = createServer((req, res) => {
    if (req.url.split('?')[0] === '/events') return handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, r))
  url = `http://127.0.0.1:${server.address().port}/events`
})

after(async () => {
  hub.close()
  await new Promise((r) => server.close(r))
})

// Each test mounts its own provider, so make sure the previous one is fully gone
// before the next reads a connection count.
beforeEach(async () => {
  await waitFor(() => assert.equal(hub.connectionCount(), 0), { timeout: 4000 })
})

/**
 * Renders children inside a provider and waits until the shared stream is really open.
 *
 * Waiting on `hub.connectionCount() === 1` is not sufficient: a previous test's socket
 * may still be tearing down, so the count can read 1 while this client has not
 * subscribed yet — and a publish issued at that moment is simply missed. Waiting on
 * this client's own state removes the ambiguity.
 */
async function mount(children, props = {}) {
  const ref = { current: null }
  function Probe() {
    ref.current = useAghoz()
    return null
  }
  const list = Array.isArray(children) ? children : [children]
  const screen = render(
    h(AghozProvider, { url, ...props }, [h(Probe, { key: '__probe' }), ...list]),
  )
  await waitFor(() => assert.equal(ref.current?.state, 'open'), { timeout: 4000 })
  return { screen, client: ref }
}

/** Publishes and lets React flush the resulting state update. */
async function publish(topic, data) {
  await act(async () => {
    await hub.publish(topic, data)
    await new Promise((r) => setTimeout(r, 40))
  })
}

// ------------------------------------------------------------------------- R2

test('useTopic renders the seeded value, then the latest push', async () => {
  function Revenue() {
    return h('span', { 'data-testid': 'v' }, String(useTopic('revenue', 41200)))
  }
  const { screen } = await mount(h(Revenue, { key: 'r' }))
  // Seeded from server-rendered data, so the first paint is never empty.
  assert.equal(screen.getByTestId('v').textContent, '41200')

  await publish('revenue', 44900)
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, '44900'))
  cleanup()
})

test('useTopic ignores topics it did not subscribe to', async () => {
  function One() {
    return h('span', { 'data-testid': 'v' }, String(useTopic('a', 0)))
  }
  const { screen } = await mount(h(One, { key: 'o' }))

  await publish('b', 999)
  assert.equal(screen.getByTestId('v').textContent, '0')
  await publish('a', 7)
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, '7'))
  cleanup()
})

// ------------------------------------------------------------------------- R3

test('useTopicEffect fires without holding state', async () => {
  const seen = []
  function Toaster() {
    useTopicEffect('orders', (order, meta) => seen.push([order.id, meta.topic]))
    return null
  }
  await mount(h(Toaster, { key: 't' }))

  await publish('orders', { id: 'ord_918' })
  await waitFor(() => assert.equal(seen.length, 1))
  assert.deepEqual(seen[0], ['ord_918', 'orders'])
  cleanup()
})

test('useTopicEffect forwards rejected async work to onHandlerError', async () => {
  const failures = []
  function Toaster() {
    useTopicEffect('orders', async () => {
      throw new Error('toast failed')
    })
    return null
  }
  await mount(h(Toaster, { key: 't' }), {
    onHandlerError: (error, meta) => failures.push([error.message, meta.topic]),
  })

  await publish('orders', { id: 'ord_async' })
  await waitFor(() => assert.equal(failures.length, 1))
  assert.deepEqual(failures[0], ['toast failed', 'orders'])
  cleanup()
})

test('an inline useTopicEffect callback does not resubscribe every render', async () => {
  // If it did, the topic set would churn and §9.3 would reconnect the shared stream on
  // every parent render — discarding the cursor each time.
  let renders = 0
  function Counter() {
    const [, force] = React.useState(0)
    renders++
    useTopicEffect('t', () => {}) // a fresh closure on every render
    React.useEffect(() => {
      if (renders < 4) force((n) => n + 1)
    })
    return null
  }
  const { client } = await mount(h(Counter, { key: 'c' }))
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })

  assert.ok(renders >= 3, `expected re-renders, saw ${renders}`)
  assert.equal(client.current.connectionCount, 1, 'one connection despite re-renders')
  cleanup()
})

// ------------------------------------------------- G2: collections need a fold

test('useTopicReducer folds events into a list', async () => {
  // useTopic cannot express this: an event carries one order, not the list.
  function Orders() {
    const orders = useTopicReducer(
      'orders',
      (list, order) => [...list, order].slice(-3),
      [{ id: 'seed' }],
    )
    return h('span', { 'data-testid': 'ids' }, orders.map((o) => o.id).join(','))
  }
  const { screen } = await mount(h(Orders, { key: 'o' }))
  assert.equal(screen.getByTestId('ids').textContent, 'seed')

  await publish('orders', { id: 'a' })
  await publish('orders', { id: 'b' })
  await waitFor(() => assert.equal(screen.getByTestId('ids').textContent, 'seed,a,b'))

  // The cap in the reducer holds, so a long-lived page cannot grow without bound.
  await publish('orders', { id: 'c' })
  await waitFor(() => assert.equal(screen.getByTestId('ids').textContent, 'a,b,c'))
  cleanup()
})

// ------------------------------------------------------------------------- R1

test('ten components across the tree share one connection', async () => {
  function Widget({ n }) {
    return h('span', {}, String(useTopic(`topic/${n}`, 0)))
  }
  const widgets = []
  for (let i = 0; i < 10; i++) widgets.push(h(Widget, { key: i, n: i }))

  const { client } = await mount(widgets)
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })

  assert.equal(client.current.connectionCount, 1, 'one connection for ten subscriptions')
  assert.equal(hub.connectionCount(), 1)
  cleanup()
})

test('the provider closes its client on unmount, and the server notices', async () => {
  function Probe() {
    useTopic('t', 0)
    return null
  }
  const { client } = await mount(h(Probe, { key: 'p' }))

  cleanup()
  await waitFor(() => assert.equal(client.current.state, 'closed'))
  await waitFor(() => assert.equal(hub.connectionCount(), 0), { timeout: 4000 })
})

test('a supplied client is not closed by the provider', async () => {
  const own = createClient({ url })
  function Probe() {
    useTopic('t', 0)
    return null
  }
  render(h(AghozProvider, { url, client: own }, h(Probe, { key: 'p' })))
  await waitFor(() => assert.equal(own.state, 'open'), { timeout: 4000 })

  cleanup()
  // The caller owns its lifetime; closing it here would break a shared client.
  assert.notEqual(own.state, 'closed')
  own.close()
  await waitFor(() => assert.equal(hub.connectionCount(), 0), { timeout: 4000 })
})

test('the provider forwards credentials, headers and an injected fetch', async () => {
  const calls = []
  const requestHeaders = { 'x-stream-auth': 'from-react-provider' }
  const transport = (input, init) => {
    calls.push(init)
    return fetch(input, init)
  }

  function Probe() {
    useTopic('private/topic', 0)
    return null
  }

  await mount(h(Probe, { key: 'p' }), {
    credentials: 'include',
    headers: requestHeaders,
    fetch: transport,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].credentials, 'include')
  assert.equal(calls[0].headers.get('x-stream-auth'), 'from-react-provider')
  assert.equal(calls[0].headers.get('accept'), 'text/event-stream')
  cleanup()
})

// ------------------------------------------------------------------- parsing

test('parse defaults to JSON and is overridable for raw strings', async () => {
  function Raw() {
    return h('span', { 'data-testid': 'v' }, useTopic('raw', '', { parse: (s) => s }))
  }
  const { screen } = await mount(h(Raw, { key: 'r' }))

  await publish('raw', 'not json at all')
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'not json at all'))
  cleanup()
})

test('useTopic outside a provider fails loudly', () => {
  function Orphan() {
    useTopic('t', 0)
    return null
  }
  assert.throws(() => render(h(Orphan)), /AghozProvider/)
  cleanup()
})
