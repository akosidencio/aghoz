// TanStack Query adapter tests.
//
// Every test runs a real hub over a real socket, a real QueryClient, and counts calls
// to a real query function. The claim being tested is a claim about refetches — how
// many happen and when — so counting them is the only honest way to check it.

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
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query')
const { AghozProvider, useAghoz } = await import('@aghoz/react')
const { useTopicInvalidation, useTopicQueryData } = await import('../dist/index.js')

const h = React.createElement

let hub
let server
let url

before(async () => {
  hub = createHub({ keepAliveMs: 0, maxHistoryBytes: 400 })
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

beforeEach(async () => {
  await waitFor(() => assert.equal(hub.connectionCount(), 0), { timeout: 4000 })
})

/** A QueryClient with retries and background refetching off, so counts are readable. */
function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity, staleTime: 0 },
    },
  })
}

/**
 * `waitOpen: false` for the cases where nothing is expected to subscribe — a client
 * with no subscribers never connects, so waiting for `open` would hang on the very
 * behaviour the test is asserting.
 */
async function mount(children, providerProps = {}, { waitOpen = true } = {}) {
  const qc = queryClient()
  const ref = { current: null }
  function Probe() {
    ref.current = useAghoz()
    return null
  }
  const list = Array.isArray(children) ? children : [children]
  const screen = render(
    h(
      QueryClientProvider,
      { client: qc },
      h(AghozProvider, { url, ...providerProps }, [h(Probe, { key: '__probe' }), ...list]),
    ),
  )
  if (waitOpen) await waitFor(() => assert.equal(ref.current?.state, 'open'), { timeout: 4000 })
  return { screen, qc, client: ref }
}

async function publish(topic, data) {
  await act(async () => {
    await hub.publish(topic, data)
    await new Promise((r) => setTimeout(r, 60))
  })
}

// ---------------------------------------------------------------- invalidation

test('an event refetches the query — the refetchInterval replacement', async () => {
  let calls = 0
  function Orders() {
    useTopicInvalidation('orders', ['orders'])
    const { data } = useQuery({
      queryKey: ['orders'],
      queryFn: async () => `load-${++calls}`,
    })
    return h('span', { 'data-testid': 'v' }, data ?? '')
  }

  const { screen } = await mount(h(Orders, { key: 'o' }))
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'load-1'))

  // No interval anywhere: the refetch happens because the server said so.
  await publish('orders', { id: 7 })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'load-2'))

  // And an event on a topic this hook did not name changes nothing.
  await publish('unrelated', { id: 8 })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(calls, 2)
  cleanup()
})

test('enabled: false does not subscribe at all', async () => {
  let calls = 0
  function Orders() {
    useTopicInvalidation('orders', ['orders'], { enabled: false })
    const { data } = useQuery({ queryKey: ['orders'], queryFn: async () => `load-${++calls}` })
    return h('span', { 'data-testid': 'v' }, data ?? '')
  }

  const { screen, client } = await mount(h(Orders, { key: 'o' }), {}, { waitOpen: false })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'load-1'))

  // Not merely "does not refetch" — it never opens a connection in the first place,
  // which is the reason the option exists.
  assert.equal(client.current.state, 'idle')
  await publish('orders', { id: 7 })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(calls, 1, 'a disabled hook must not refetch')
  cleanup()
})

test('debounceMs collapses a burst into one refetch', async () => {
  let calls = 0
  function Orders() {
    useTopicInvalidation('orders', ['orders'], { debounceMs: 80 })
    const { data } = useQuery({ queryKey: ['orders'], queryFn: async () => `load-${++calls}` })
    return h('span', { 'data-testid': 'v' }, data ?? '')
  }

  const { screen } = await mount(h(Orders, { key: 'o' }))
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'load-1'))

  await act(async () => {
    for (let i = 0; i < 10; i++) await hub.publish('orders', { id: i })
    await new Promise((r) => setTimeout(r, 250))
  })

  // Ten events, one refetch. Without this a hot topic is heavier than the polling it
  // replaced, which is the one way this package can make things worse.
  assert.equal(calls, 2, `expected one extra refetch, saw ${calls - 1}`)
  cleanup()
})

// ------------------------------------------------------------------- folding

test('useTopicQueryData folds into the cache without refetching', async () => {
  let calls = 0
  function Orders() {
    useTopicQueryData('orders', ['orders'], (current, event) => [...current, event.id])
    const { data } = useQuery({
      queryKey: ['orders'],
      queryFn: async () => {
        calls++
        return [1]
      },
    })
    return h('span', { 'data-testid': 'v' }, (data ?? []).join(','))
  }

  const { screen } = await mount(h(Orders, { key: 'o' }))
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, '1'))

  await publish('orders', { id: 2 })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, '1,2'))
  await publish('orders', { id: 3 })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, '1,2,3'))

  // The whole point: the list grew with no trip to the server at all.
  assert.equal(calls, 1, 'folding must not refetch')
  cleanup()
})

// ----------------------------------------------------------------------- gaps

test('a gap refetches a folded cache instead of leaving it silently wrong', async () => {
  // A folded cache is only correct while every event has been seen. This is the case
  // where it has not been — and getting it wrong is invisible, which is why it is the
  // most important test in this file.
  //
  // The gap is real, not simulated: publish past `maxHistoryBytes`, then connect with
  // a cursor pointing at an event that has since been trimmed. The server answers
  // `earliest`, per §8.1.
  //
  // The padding is inside a JSON object rather than being a bare string of x's, because
  // this test is about the gap and the default parse is `JSON.parse`. Unparseable
  // payloads make every replayed event a §9.2 handler failure, which now invalidates on
  // its own and would leave this counting two failures rather than one gap.
  const first = await hub.publish('orders', { pad: 'x'.repeat(110) })
  for (let i = 0; i < 20; i++) await hub.publish('orders', { pad: 'x'.repeat(110) })

  let calls = 0
  const gaps = []
  function Orders() {
    useTopicQueryData('orders', ['orders'], (current, event) => [...current, event.id])
    const { data } = useQuery({
      queryKey: ['orders'],
      queryFn: async () => {
        calls++
        return [`server-${calls}`]
      },
    })
    return h('span', { 'data-testid': 'v' }, (data ?? []).join(','))
  }

  const { screen } = await mount(h(Orders, { key: 'o' }), {
    initialCursor: first.id,
    onGap: (reason) => gaps.push(reason),
  })

  // The application's own gap callback still fires: an adapter subscribing to gaps
  // must not take the signal away from the banner the app already renders.
  await waitFor(() => assert.deepEqual(gaps, ['history-truncated']), { timeout: 4000 })

  // And the cache went back to the server rather than carrying on folding onto a value
  // that is missing everything the gap covered. What replay still had to offer folds on
  // top of that answer, which is the correct order and the reason this asserts on the
  // prefix: the refetched value is the base, not something the fold overwrote.
  await waitFor(
    () => assert.ok(screen.getByTestId('v').textContent.startsWith('server-2')),
    { timeout: 4000 },
  )
  assert.equal(calls, 2, 'one refetch for the gap, and no refetch per replayed event')
  cleanup()
})

test('the gap alone refetches, with no event on the topic at all', async () => {
  // The flood is published on `orders`, and the hook subscribes to `audit`. So the
  // truncation is real and the checkpoint says `earliest`, but nothing is replayed to
  // this subscriber — which makes the single refetch attributable to the gap and to
  // nothing else. (The previous test cannot make that claim: a trimmed history still
  // replays whatever survived, and each of those events invalidates on its own.)
  const first = await hub.publish('orders', 'x'.repeat(120))
  for (let i = 0; i < 20; i++) await hub.publish('orders', 'x'.repeat(120))

  let calls = 0
  function Audit() {
    useTopicInvalidation('audit', ['audit'])
    const { data } = useQuery({ queryKey: ['audit'], queryFn: async () => `load-${++calls}` })
    return h('span', { 'data-testid': 'v' }, data ?? '')
  }

  const { screen } = await mount(h(Audit, { key: 'a' }), { initialCursor: first.id })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'load-2'), {
    timeout: 4000,
  })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(calls, 2, 'exactly one refetch, caused by the gap')
  cleanup()
})

// ------------------------------------------------------- §9.3 topic-set cutover

test('a lazily mounted topic refetches once its stream is open', async () => {
  // §9.3: the cursor the replacement stream resumes from advanced while `audit` was not
  // subscribed, so it is not a baseline for `audit`. Nothing is reported as a gap —
  // the hub is right that it lost nothing — and a cache that trusted the cursor here
  // would serve whatever the query happened to fetch before the stream carried it.
  let orderCalls = 0
  let auditCalls = 0
  let show

  function Orders() {
    useTopicInvalidation('orders', ['orders'])
    const { data } = useQuery({ queryKey: ['orders'], queryFn: async () => `orders-${++orderCalls}` })
    return h('span', { 'data-testid': 'o' }, data ?? '')
  }

  function Audit() {
    useTopicInvalidation('audit', ['audit'])
    const { data } = useQuery({ queryKey: ['audit'], queryFn: async () => `audit-${++auditCalls}` })
    return h('span', { 'data-testid': 'a' }, data ?? '')
  }

  function Shell() {
    const [visible, setVisible] = React.useState(false)
    show = setVisible
    return h(React.Fragment, null, h(Orders, { key: 'o' }), visible ? h(Audit, { key: 'a' }) : null)
  }

  const { screen } = await mount(h(Shell, { key: 's' }), { initialCursor: hub.cursor() })
  await waitFor(() => assert.equal(screen.getByTestId('o').textContent, 'orders-1'))

  // Moves the cursor while `audit` has no subscriber — the interleaving §9.3 describes.
  await publish('orders', { id: 1 })
  await waitFor(() => assert.equal(screen.getByTestId('o').textContent, 'orders-2'))

  await act(async () => {
    show(true)
    await new Promise((r) => setTimeout(r, 200))
  })

  // Mounted once, then refetched once because the stream that now carries `audit`
  // resumed from a cursor that never covered it. No `audit` event was ever published.
  await waitFor(() => assert.equal(auditCalls, 2), { timeout: 4000 })
  await waitFor(() => assert.equal(screen.getByTestId('a').textContent, 'audit-2'))
  cleanup()
})

test('a topic mounting before anything arrives does not refetch', async () => {
  // The other half of the rule. Every component in a first render pass — including the
  // ones a suspense boundary mounts a tick late — shares the cursor the page's data was
  // read at, so firing here would put a second fetch on every page load and teach
  // applications to switch the signal off.
  let auditCalls = 0
  let show

  function Audit() {
    useTopicInvalidation('audit', ['audit'])
    const { data } = useQuery({ queryKey: ['audit2'], queryFn: async () => `audit-${++auditCalls}` })
    return h('span', { 'data-testid': 'a' }, data ?? '')
  }

  function Shell() {
    const [visible, setVisible] = React.useState(false)
    show = setVisible
    return h(React.Fragment, null, h(Orders, { key: 'o' }), visible ? h(Audit, { key: 'a' }) : null)
  }

  function Orders() {
    useTopicInvalidation('orders', ['orders3'])
    return h('span', null, 'x')
  }

  await mount(h(Shell, { key: 's' }), { initialCursor: hub.cursor() })

  await act(async () => {
    show(true)
    await new Promise((r) => setTimeout(r, 250))
  })

  assert.equal(auditCalls, 1, 'mounted once, and no cutover refetch on top of it')
  cleanup()
})

// ----------------------------------------------------- §9.2 handler failure

test('a parse failure invalidates instead of leaving an advanced cursor over stale state', async () => {
  // The cursor advances before handlers run (§9.2), so the event that threw is never
  // delivered again. Without this the fold is permanently behind by one event and
  // nothing anywhere reports it — the exact silent staleness this project exists to
  // remove, reached through the adapter rather than the transport.
  let calls = 0
  const errors = []

  function Orders() {
    useTopicQueryData('orders', ['orders-fold'], (current, event) => [...current, event.id])
    const { data } = useQuery({
      queryKey: ['orders-fold'],
      queryFn: async () => [`server-${++calls}`],
    })
    return h('span', { 'data-testid': 'v' }, (data ?? []).join(','))
  }

  const { screen } = await mount(h(Orders, { key: 'o' }), {
    initialCursor: hub.cursor(),
    onError: (error) => errors.push(error),
  })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'server-1'))

  // A payload the default `JSON.parse` cannot read. Published as a raw string, which is
  // how a service that forgot to serialise its event body reaches a browser.
  await publish('orders', 'this is not json')

  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'server-2'), {
    timeout: 4000,
  })
  assert.equal(calls, 2, 'the failure became a refetch, not a silently skipped event')
  // And it is still reported: the invalidation is recovery, not suppression.
  assert.ok(errors.length >= 1, 'the parse failure still reaches onError')
  cleanup()
})

test('an updater that throws invalidates the query it could not fold into', async () => {
  let calls = 0

  function Orders() {
    useTopicQueryData('orders', ['orders-throw'], () => {
      throw new Error('fold failed')
    })
    const { data } = useQuery({
      queryKey: ['orders-throw'],
      queryFn: async () => [`server-${++calls}`],
    })
    return h('span', { 'data-testid': 'v' }, (data ?? []).join(','))
  }

  const { screen } = await mount(h(Orders, { key: 'o' }), { initialCursor: hub.cursor() })
  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'server-1'))

  await publish('orders', { id: 1 })

  await waitFor(() => assert.equal(screen.getByTestId('v').textContent, 'server-2'), {
    timeout: 4000,
  })
  assert.equal(calls, 2)
  cleanup()
})
