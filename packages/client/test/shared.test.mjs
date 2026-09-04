// Multi-tab connection sharing — PROTOCOL.md §9.1.
//
// Real tabs are not available here, and mocking them would prove nothing, so each "tab"
// is a SharedClient instance in this process. Two things make that an honest simulation:
// `BroadcastChannel` is real and genuinely cross-instance in Node, excluding the sender
// exactly as a browser does; and the connection underneath is a real socket to a real
// hub, so replay, handoff and gap reporting behave as they will in a browser.
//
// The one thing that must be faked is `navigator.locks`, which Node has no equivalent of.
// `fakeLocks` below implements the only property the design leans on: the lock is granted
// to one holder, queued for the rest, and handed to the next in line the instant the
// holder lets go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '@aghoz/server'
import { createSharedClient } from '../dist/index.js'

// ------------------------------------------------------------------- harness

/**
 * A LockManager with browser semantics: exclusive, FIFO, and released automatically when
 * the holder's callback settles or its signal aborts.
 */
function fakeLocks() {
  const queues = new Map()
  return {
    request(name, options, callback) {
      const queue = queues.get(name) ?? []
      queues.set(name, queue)

      return new Promise((resolve, reject) => {
        const entry = { callback, resolve, reject, signal: options.signal, granted: false }

        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(entry)
          if (i !== -1 && !entry.granted) {
            // Never held it — a tab closing before it was ever promoted.
            queue.splice(i, 1)
            reject(new Error('aborted'))
            return
          }
          if (entry.granted) {
            queue.shift()
            resolve(undefined)
            pump(name)
          }
        })

        queue.push(entry)
        pump(name)
      })
    },
  }

  function pump(name) {
    const queue = queues.get(name)
    if (queue === undefined || queue.length === 0) return
    const head = queue[0]
    if (head.granted) return
    head.granted = true
    // Async, like the real thing: a grant never happens inside `request()`.
    queueMicrotask(() => {
      head.callback().then(
        () => {
          if (queue[0] === head) queue.shift()
          head.resolve(undefined)
          pump(name)
        },
        (error) => {
          if (queue[0] === head) queue.shift()
          head.reject(error)
          pump(name)
        },
      )
    })
  }
}

async function boot({ hubOptions = {}, authorize } = {}) {
  const hub = createHub({ keepAliveMs: 0, ...hubOptions })
  const handler = hub.handler(authorize === undefined ? {} : { authorize })
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

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

async function until(predicate, ms = 3000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Opens `n` tabs against one hub, all sharing a lock namespace and a channel name.
 *
 * Each gets a distinct channel *instance* on the same name, which is what a browser gives
 * separate tabs — one BroadcastChannel per tab, all joined by name.
 */
function openTabs(n, url, options = {}) {
  const locks = options.locks ?? fakeLocks()
  const name = options.name ?? `tabs-${Math.random().toString(36).slice(2)}`
  const tabs = []
  for (let i = 0; i < n; i++) {
    tabs.push(
      createSharedClient({
        url,
        name,
        locks,
        debounceMs: 5,
        channel: () => new BroadcastChannel(name),
        ...options.client,
      }),
    )
  }
  return { tabs, locks, name, closeAll: () => tabs.forEach((t) => t.close()) }
}

/** Exactly one tab may hold the connection at a time. */
function leaderOf(tabs) {
  const leaders = tabs.filter((t) => t.isLeader)
  assert.equal(leaders.length, 1, `expected exactly one leader, found ${leaders.length}`)
  return leaders[0]
}

// ------------------------------------------------------------------- election

test('five tabs elect one leader and open exactly one connection', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(5, s.url)
  try {
    const seen = tabs.map(() => [])
    tabs.forEach((tab, i) => tab.subscribe('t', (data) => seen[i].push(data)))

    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'all tabs open')
    leaderOf(tabs)

    // The point of the whole feature: five tabs, one socket.
    assert.equal(s.hub.stats().connections, 1, 'five tabs must share one connection')

    await s.hub.publish('t', 'v')
    await until(() => seen.every((s) => s.length === 1), 3000, 'fan-out to every tab')
    assert.deepEqual(
      seen.map((s) => s[0]),
      ['v', 'v', 'v', 'v', 'v'],
    )
  } finally {
    closeAll()
    await s.close()
  }
})

test('the elected leader forwards credentials and refreshes dynamic headers', async () => {
  const s = await boot()
  const locks = fakeLocks()
  const name = `auth-${Math.random().toString(36).slice(2)}`
  const calls = []
  let token = 'first'
  const client = createSharedClient({
    url: s.url,
    name,
    locks,
    channel: () => new BroadcastChannel(name),
    debounceMs: 5,
    baseBackoffMs: 20,
    credentials: 'include',
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: (input, init) => {
      calls.push(init)
      return fetch(input, init)
    },
  })

  try {
    client.subscribe('private/topic', () => {})
    await until(() => client.isLeader && client.state === 'open', 3000, 'authenticated leader')

    assert.equal(calls[0].credentials, 'include')
    assert.equal(calls[0].headers.get('authorization'), 'Bearer first')

    token = 'refreshed'
    s.hub.disconnect(() => true)
    await until(() => calls.length === 2 && client.state === 'open', 3000, 'leader reconnect')
    assert.equal(calls[1].headers.get('authorization'), 'Bearer refreshed')
  } finally {
    client.close()
    await s.close()
  }
})

test('a tab that joins later attaches to the existing leader rather than connecting', async () => {
  const s = await boot()
  const { tabs, locks, name, closeAll } = openTabs(1, s.url)
  const extra = []
  try {
    tabs[0].subscribe('t', () => {})
    await until(() => tabs[0].state === 'open', 3000, 'first tab open')
    assert.equal(s.hub.stats().connections, 1)

    const late = createSharedClient({
      url: s.url,
      name,
      locks,
      debounceMs: 5,
      channel: () => new BroadcastChannel(name),
    })
    extra.push(late)
    const got = []
    late.subscribe('t', (data) => got.push(data))

    await until(() => late.state === 'open', 3000, 'late tab adopts leader state')
    assert.equal(late.isLeader, false)
    assert.equal(s.hub.stats().connections, 1, 'a late tab must not open a second connection')

    await s.hub.publish('t', 'late')
    await until(() => got.length === 1, 3000, 'late tab receives')
  } finally {
    extra.forEach((t) => t.close())
    closeAll()
    await s.close()
  }
})

// ---------------------------------------------------------------- topic union

test('the leader subscribes to the union, so each tab gets only what it asked for', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(3, s.url)
  try {
    const a = []
    const b = []
    const c = []
    tabs[0].subscribe('alpha', (d) => a.push(d))
    tabs[1].subscribe('beta', (d) => b.push(d))
    tabs[2].subscribe('alpha', (d) => c.push(d))

    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')
    await tick(80)

    await s.hub.publish('alpha', 'A')
    await s.hub.publish('beta', 'B')
    await until(() => a.length === 1 && b.length === 1 && c.length === 1, 3000, 'delivery')

    assert.deepEqual(a, ['A'], 'a tab must not receive a topic it never subscribed to')
    assert.deepEqual(b, ['B'])
    assert.deepEqual(c, ['A'])
    assert.equal(s.hub.stats().connections, 1)
  } finally {
    closeAll()
    await s.close()
  }
})

test('a follower subscribing to a new topic widens the shared subscription', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    tabs[0].subscribe('alpha', () => {})
    await until(() => tabs[0].state === 'open', 3000, 'open')

    // `beta` is not in the union yet, so this has to reach the leader and reconnect.
    const got = []
    const follower = tabs.find((t) => !t.isLeader)
    follower.subscribe('beta', (d) => got.push(d))
    await tick(150)

    await s.hub.publish('beta', 'B')
    await until(() => got.length === 1, 3000, 'the union widened')
    assert.equal(s.hub.stats().connections, 1, 'widening must not add a connection')
  } finally {
    closeAll()
    await s.close()
  }
})

// -------------------------------------------------------------------- handoff

test('a promoted tab resumes the shared stream without losing an event', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    const got = []
    tabs.forEach((tab) => tab.subscribe('t', (d) => got.push(d)))
    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')

    await s.hub.publish('t', 'before')
    await until(() => got.length === 2, 3000, 'both tabs receive')

    // The leader's tab goes away. The browser reclaims the lock; the survivor is promoted.
    const leader = leaderOf(tabs)
    const survivor = tabs.find((t) => t !== leader)
    leader.close()

    await until(() => survivor.isLeader, 3000, 'promotion')
    await until(() => survivor.state === 'open', 3000, 'the new leader connects')

    got.length = 0
    await s.hub.publish('t', 'after')
    await until(() => got.length === 1, 3000, 'the promoted tab still receives')
    assert.deepEqual(got, ['after'])
    assert.equal(s.hub.stats().connections, 1, 'the old connection must not linger')
  } finally {
    closeAll()
    await s.close()
  }
})

test('an event published while no tab holds the stream is replayed after promotion', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    await until(() => tabs.some((t) => t.isLeader), 3000, 'election')
    const leader = leaderOf(tabs)
    const survivor = tabs.find((t) => t !== leader)

    // Only the leader subscribes. The survivor is a tab with no topics, which is what
    // makes the window deterministic: when it is promoted its union is empty, so it opens
    // no connection, and the publish below is guaranteed to land while nothing is
    // listening. Racing a real promotion with a fixed sleep does not reliably produce
    // that window — the new leader usually wins.
    const leaderGot = []
    leader.subscribe('t', (d) => leaderGot.push(d))
    await until(() => leader.state === 'open', 3000, 'open')

    await s.hub.publish('t', 'one')
    await until(() => leaderGot.length === 1, 3000, 'first delivery')
    // The survivor has no handler for `t`, but its cursor still advanced — every tab
    // tracks every forwarded event precisely so that this handoff is possible.
    await until(() => survivor.cursor !== undefined, 2000, 'the follower tracked the cursor')

    leader.close()
    await until(() => survivor.isLeader, 3000, 'promotion')
    await until(() => s.hub.stats().connections === 0, 3000, 'no tab holds the stream')

    await s.hub.publish('t', 'during-the-gap')

    // Now the promoted tab asks for the topic. It resumes from the cursor it learned by
    // watching, so the server replays what was missed. Starting from "now" instead would
    // lose the event with nothing reported — the failure this library exists to remove.
    const got = []
    survivor.subscribe('t', (d) => got.push(d))
    await until(() => got.length === 1, 4000, 'the missed event is replayed')
    assert.deepEqual(got, ['during-the-gap'], 'and nothing older is replayed with it')
  } finally {
    closeAll()
    await s.close()
  }
})

test('replay after promotion is deduped rather than delivered twice', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    const got = []
    await until(() => tabs.some((t) => t.isLeader), 3000, 'election')
    const leader = leaderOf(tabs)
    const survivor = tabs.find((t) => t !== leader)
    survivor.subscribe('t', (d) => got.push(d))
    leader.subscribe('t', () => {})

    await until(() => survivor.state === 'open', 3000, 'open')
    for (const v of ['a', 'b', 'c']) await s.hub.publish('t', v)
    await until(() => got.length === 3, 3000, 'initial delivery')

    leader.close()
    await until(() => survivor.isLeader && survivor.state === 'open', 4000, 'promotion')
    await tick(200)

    // The server replays from the cursor, and everything at or below it must be dropped.
    assert.deepEqual(got, ['a', 'b', 'c'], 'a handoff must not re-deliver history')
  } finally {
    closeAll()
    await s.close()
  }
})

test('a tab further ahead than the leader skips what the leader replays', async () => {
  // The case the per-tab dedupe exists for, and the only one that actually produces a
  // duplicate: a tab reloaded a moment ago holds a fresher cursor than a leader that has
  // been open for hours. The leader reconnects, the server replays from *its* cursor, and
  // the newer tab is forwarded events it has already applied.
  const s = await boot()
  const ids = []
  for (const v of ['one', 'two', 'three']) ids.push((await s.hub.publish('t', v)).id)

  const name = `ahead-${Math.random().toString(36).slice(2)}`
  const locks = fakeLocks()
  const make = (initialCursor) =>
    createSharedClient({
      url: s.url,
      name,
      locks,
      debounceMs: 5,
      initialCursor,
      channel: () => new BroadcastChannel(name),
    })

  // First created wins the lock, so the stale tab leads and the fresh tab follows.
  const stale = make(ids[0])
  const fresh = make(ids[2])
  try {
    const staleGot = []
    const freshGot = []
    stale.subscribe('t', (d) => staleGot.push(d))
    fresh.subscribe('t', (d) => freshGot.push(d))

    await until(() => stale.isLeader, 3000, 'the stale tab leads')
    await until(() => staleGot.length === 2, 3000, 'the leader replays what it missed')
    await tick(250)

    assert.deepEqual(staleGot, ['two', 'three'], 'the stale tab catches up')
    assert.deepEqual(freshGot, [], 'the tab that already had them must render nothing')

    // And it is caught up rather than stuck: the next live event still arrives.
    await s.hub.publish('t', 'four')
    await until(() => freshGot.length === 1, 3000, 'live delivery continues')
    assert.deepEqual(freshGot, ['four'])
  } finally {
    stale.close()
    fresh.close()
    await s.close()
  }
})

// ------------------------------------------------------------------ gap + origin

test('a gap detected by the leader reaches every tab', async () => {
  // A tiny history, so a cursor from before the eviction is reported as a real loss.
  const s = await boot({ hubOptions: { maxHistoryBytes: 200 } })
  const first = await s.hub.publish('t', 'x'.repeat(120))
  for (let i = 0; i < 3; i++) await s.hub.publish('t', 'x'.repeat(120))

  const gaps = []
  const { tabs, closeAll } = openTabs(3, s.url, {
    client: { initialCursor: first.id, onGap: (reason) => gaps.push(reason) },
  })
  try {
    tabs.forEach((tab) => tab.subscribe('t', () => {}))
    await until(() => gaps.length === 3, 3000, 'every tab hears about the gap')
    assert.deepEqual(gaps, ['history-truncated', 'history-truncated', 'history-truncated'])
  } finally {
    closeAll()
    await s.close()
  }
})

test('§6.0 — only the tab that caused a write skips its own echo', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(3, s.url)
  try {
    const seen = tabs.map(() => [])
    tabs.forEach((tab, i) => tab.subscribe('t', (d) => seen[i].push(d)))
    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')
    await tick(60)

    // Tab 1 issues the write, so the server echoes tab 1's origin back.
    await s.hub.publish('t', 'mine', { origin: tabs[1].originId })
    await tick(250)

    assert.deepEqual(seen[0], ['mine'], 'other tabs must still see it')
    assert.deepEqual(seen[1], [], 'the originating tab must skip its own echo')
    assert.deepEqual(seen[2], ['mine'])

    // And the skip must not stall the cursor, or every later reconnect replays it.
    await s.hub.publish('t', 'next')
    await until(() => seen[1].length === 1, 3000, 'the skipping tab keeps up')
    assert.deepEqual(seen[1], ['next'])
  } finally {
    closeAll()
    await s.close()
  }
})

test('the origin skip works when the leader itself is the writer', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    const seen = tabs.map(() => [])
    tabs.forEach((tab, i) => tab.subscribe('t', (d) => seen[i].push(d)))
    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')
    await tick(60)

    // The inner connection uses an origin no tab has, precisely so the leader's own echo
    // still reaches it and is judged here rather than filtered away in transport.
    const leader = leaderOf(tabs)
    const i = tabs.indexOf(leader)
    await s.hub.publish('t', 'leader-wrote', { origin: leader.originId })
    await tick(250)

    assert.deepEqual(seen[i], [], 'the leader must skip its own echo too')
    assert.deepEqual(seen[1 - i], ['leader-wrote'], 'and the follower must still receive it')
  } finally {
    closeAll()
    await s.close()
  }
})

// ------------------------------------------------------------------- lifecycle

// Three tabs, three different topics — the shape that exposes what two identical tabs
// cannot. Only the leader tracks who wants what, so a promoted tab starts from its own
// topics alone; the tabs that did not move never announced themselves to it, and their
// topics silently leave the union. They keep their state, their cursor and their open
// callbacks. They simply stop receiving, which is the failure §0 exists to eliminate.
test('a promotion keeps the topics of the tabs that did not move', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(3, s.url)
  try {
    const alpha = []
    const beta = []
    const gamma = []
    tabs[0].subscribe('alpha', (d) => alpha.push(d))
    tabs[1].subscribe('beta', (d) => beta.push(d))
    tabs[2].subscribe('gamma', (d) => gamma.push(d))

    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')
    await tick(120)
    await s.hub.publish('gamma', 'before')
    await until(() => gamma.length === 1, 3000, 'the third tab receives while the first leads')

    const leader = leaderOf(tabs)
    const survivors = tabs.filter((t) => t !== leader)
    leader.close()
    await until(() => survivors.some((t) => t.isLeader), 3000, 'promotion')
    const promoted = survivors.find((t) => t.isLeader)
    const bystander = survivors.find((t) => t !== promoted)
    await until(() => promoted.state === 'open', 3000, 'the new leader connects')
    await tick(200)

    await s.hub.publish('beta', 'B')
    await s.hub.publish('gamma', 'G')
    await until(() => beta.length + gamma.length === 3, 3000, 'both survivors still receive')
    assert.equal(bystander.state, 'open', 'and the bystander never learned anything was wrong')
    assert.equal(s.hub.stats().connections, 1, 'still one connection')
  } finally {
    closeAll()
    await s.close()
  }
})

test('closing a follower drops its topics from the shared subscription', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    const leader = (await until(() => tabs.some((t) => t.isLeader), 3000, 'election'), leaderOf(tabs))
    const follower = tabs.find((t) => t !== leader)

    leader.subscribe('alpha', () => {})
    const got = []
    follower.subscribe('beta', (d) => got.push(d))
    await until(() => leader.state === 'open', 3000, 'open')
    await tick(120)

    follower.close()
    await tick(150)

    // `beta` belonged only to the closed tab, so nothing should be listening for it.
    await s.hub.publish('beta', 'orphan')
    await tick(200)
    assert.deepEqual(got, [], 'a closed tab must not still receive')
    assert.equal(s.hub.stats().connections, 1, 'the leader keeps its connection')
  } finally {
    closeAll()
    await s.close()
  }
})

test('state changes propagate from the leader to every tab', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(3, s.url)
  try {
    tabs.forEach((tab) => tab.subscribe('t', () => {}))
    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'all report open')
    // A follower has no socket of its own, so its state is only ever as truthful as the
    // leader's reporting — an application showing a connection indicator depends on this.
    for (const tab of tabs) assert.equal(tab.state, 'open')
  } finally {
    closeAll()
    await s.close()
  }
})

test('close() is idempotent and releases the lock for the next tab', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url)
  try {
    tabs.forEach((tab) => tab.subscribe('t', () => {}))
    await until(() => tabs.every((t) => t.state === 'open'), 3000, 'open')

    const leader = leaderOf(tabs)
    const survivor = tabs.find((t) => t !== leader)
    leader.close()
    leader.close()
    assert.equal(leader.state, 'closed')

    await until(() => survivor.isLeader, 3000, 'the lock was released, not leaked')
  } finally {
    closeAll()
    await s.close()
  }
})

test('a client with no locks available refuses rather than guessing at an election', async () => {
  // Degrading to a heartbeat would reintroduce silent staleness: too long a timeout and
  // every tab is blind after a crash, which is the failure the library exists to remove.
  //
  // The ambient `navigator` is stubbed for the duration rather than relied upon. Node 22
  // has a `navigator` with no `locks` on it, Node 24 ships the real Web Locks API, and a
  // test whose meaning depends on which one it happens to run under is not testing the
  // library — it caught exactly that, passing on 22 and failing on 24.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
  const channels = []
  try {
    assert.throws(
      () =>
        createSharedClient({
          url: 'http://127.0.0.1:1/events',
          channel: () => {
            const c = new BroadcastChannel('nope')
            channels.push(c)
            return c
          },
        }),
      /navigator\.locks/,
    )
    // And nothing was left open by the throw. An orphaned channel keeps Node's event loop
    // alive forever, which is how this was found the first time.
    assert.equal(channels.length, 0, 'the channel must not be opened before the check')
  } finally {
    channels.forEach((c) => c.close())
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
})

test('a real navigator.locks is picked up without being passed in', async () => {
  // The other half: where the platform provides Web Locks — every target browser, and
  // Node 24 — no injection is needed. Stubbed rather than depending on the runtime, for
  // the same reason as above.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let requested
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      locks: {
        request(name, options, callback) {
          requested = name
          return Promise.resolve(callback())
        },
      },
    },
    configurable: true,
  })
  const name = `ambient-${Math.random().toString(36).slice(2)}`
  let client
  try {
    client = createSharedClient({
      url: 'http://127.0.0.1:1/events',
      name,
      channel: () => new BroadcastChannel(name),
    })
    await until(() => client.isLeader, 2000, 'the ambient lock manager was used')
    assert.equal(requested, name, 'and it was asked for this hub\'s own lock')
  } finally {
    client?.close()
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
})

// ------------------------------------------------------------- §9.3 cutover

test('a topic a second tab adds late is reported as a cutover in every tab', async () => {
  // The leader owns the connection, so the leader is the only one that knows when the
  // shared stream reopened and with what set. It decides and broadcasts; a follower that
  // recomputed this from its own view would be guessing.
  const s = await boot()
  const cutovers = [[], []]
  const { tabs, closeAll } = openTabs(2, s.url, {
    client: { initialCursor: s.hub.cursor() },
  })
  try {
    tabs.forEach((tab, i) => tab.onCutover((topics) => cutovers[i].push([...topics])))

    const seen = []
    tabs[0].subscribe('a', (data) => seen.push(data))
    await until(() => tabs.some((t) => t.state === 'open'), 3000, 'open')

    // Moves the shared cursor while nobody is watching `b`.
    await s.hub.publish('b', { n: 11 })
    await s.hub.publish('a', { n: 12 })
    await until(() => seen.length === 1, 3000, 'a delivered')

    tabs[1].subscribe('b', () => {})
    await until(() => cutovers[0].length === 1 && cutovers[1].length === 1, 3000, 'cutover')

    assert.deepEqual(cutovers[0], [['b']], 'the leader reports it')
    assert.deepEqual(cutovers[1], [['b']], 'and every tab hears it, including the one that asked')
  } finally {
    closeAll()
    await s.close()
  }
})

test('a handler that throws in one tab is reported with its topic, in that tab only', async () => {
  // §9.2. Handlers are per tab — the leader forwards frames, not callbacks — so this one
  // is deliberately not broadcast: a tab that folded the event successfully has nothing
  // to recover from.
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url, {
    client: { initialCursor: s.hub.cursor() },
  })
  try {
    const failures = [[], []]
    tabs.forEach((tab, i) => tab.onHandlerError((_error, meta) => failures[i].push(meta.topic)))

    const ok = []
    tabs[0].subscribe('t', () => {
      throw new Error('fold failed')
    })
    tabs[1].subscribe('t', (data) => ok.push(data))
    await until(() => tabs.some((t) => t.state === 'open'), 3000, 'open')

    await s.hub.publish('t', { n: 1 })
    await until(() => failures[0].length === 1 && ok.length === 1, 3000, 'delivery')

    assert.deepEqual(failures[0], ['t'])
    assert.deepEqual(failures[1], [], 'the tab whose handler succeeded hears nothing')
  } finally {
    closeAll()
    await s.close()
  }
})

test('a handler that rejects in one tab is reported with its topic, in that tab only', async () => {
  const s = await boot()
  const { tabs, closeAll } = openTabs(2, s.url, {
    client: { initialCursor: s.hub.cursor() },
  })
  try {
    const failures = [[], []]
    tabs.forEach((tab, i) => tab.onHandlerError((_error, meta) => failures[i].push(meta.topic)))

    const ok = []
    tabs[0].subscribe('t', async () => {
      throw new Error('async fold failed')
    })
    tabs[1].subscribe('t', (data) => ok.push(data))
    await until(() => tabs.some((t) => t.state === 'open'), 3000, 'open')

    await s.hub.publish('t', { n: 1 })
    await until(() => failures[0].length === 1 && ok.length === 1, 3000, 'delivery')

    assert.deepEqual(failures[0], ['t'])
    assert.deepEqual(failures[1], [])
  } finally {
    closeAll()
    await s.close()
  }
})
