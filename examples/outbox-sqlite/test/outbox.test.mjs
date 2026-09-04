// The publication boundary, as a test rather than as advice.
//
// Each case names a window in which an ordinary "publish after you commit" application
// loses or invents an event, and shows the outbox closing it. The crash cases matter
// most: they are the ones no gap detection can report, because nothing was ever
// accepted for it to detect a gap *in*.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '@aghoz/server'
import { openDatabase, withOutbox, createRelay } from '../outbox.mjs'

function boot() {
  const db = openDatabase()
  const hub = createHub({ keepAliveMs: 0 })
  const published = []
  // Records what reached the hub, in order, without needing a socket.
  const originalPublish = hub.publish.bind(hub)
  hub.publish = async (topic, payload, options) => {
    const ack = await originalPublish(topic, payload, options)
    published.push({ topic, payload, id: ack.id })
    return ack
  }
  return { db, hub, published, relay: createRelay({ db, hub }) }
}

function placeOrder(db, title) {
  return withOutbox(db, (emit) => {
    const info = db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run(title, 100)
    const id = Number(info.lastInsertRowid)
    emit('orders', { id, title })
    return id
  })
}

test('a write and its event commit together, and the relay publishes it', async () => {
  const { db, published, relay } = boot()
  placeOrder(db, 'first')

  assert.deepEqual(published, [], 'nothing is published from inside the transaction')
  await relay.drain()

  assert.equal(published.length, 1)
  assert.equal(published[0].topic, 'orders')
  assert.deepEqual(JSON.parse(published[0].payload), { id: 1, title: 'first' })
})

test('a crash between the commit and the publish loses nothing', async () => {
  // The window that makes documentation insufficient. The row is committed, the process
  // dies, and an application that published after committing has an order no subscriber
  // will ever hear about — and no gap, because the hub never accepted the event.
  const { db, published, relay } = boot()
  placeOrder(db, 'survives')

  // "The process died here." Nothing ran the relay; the outbox row is on disk.
  const pending = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get()
  assert.equal(pending.n, 1)

  // Restart: the relay drains what the previous process left behind.
  await relay.drain()
  assert.equal(published.length, 1)
  assert.deepEqual(JSON.parse(published[0].payload), { id: 1, title: 'survives' })
})

test('a rolled-back transaction publishes nothing', async () => {
  // The mirror failure, and the worse one: an event for something that never happened
  // cannot be recovered from by refetching, because the refetch agrees with the
  // database and disagrees with what every client was told.
  const { db, published, relay } = boot()

  assert.throws(() => {
    withOutbox(db, (emit) => {
      db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run('doomed', 1)
      emit('orders', { id: 999, title: 'doomed' })
      throw new Error('payment declined')
    })
  }, /payment declined/)

  await relay.drain()
  assert.deepEqual(published, [], 'no event for a write that did not happen')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0)
})

test('the relay publishes in outbox order', async () => {
  // Two transactions, one relay pass. Ids are assigned at publish, so the outbox's own
  // order is the only thing that decides what subscribers see first.
  const { db, published, relay } = boot()
  placeOrder(db, 'one')
  placeOrder(db, 'two')
  placeOrder(db, 'three')

  await relay.drain()
  assert.deepEqual(
    published.map((p) => JSON.parse(p.payload).title),
    ['one', 'two', 'three'],
  )
})

test('a second drain does not republish what the first one acked', async () => {
  const { db, published, relay } = boot()
  placeOrder(db, 'once')

  await relay.drain()
  await relay.drain()
  assert.equal(published.length, 1, 'sent_at is the idempotency of the relay')
})

test('a failed publish leaves the row unsent, and the next pass sends it', async () => {
  // At-least-once, demonstrated. The row is acked only after the hub accepted it, so a
  // backplane that was briefly unreachable costs a retry rather than an event.
  const { db, hub, published, relay } = boot()
  const working = hub.publish
  let failed = false
  hub.publish = async (...args) => {
    if (!failed) {
      failed = true
      throw new Error('redis unreachable')
    }
    return working(...args)
  }

  placeOrder(db, 'retried')
  await assert.rejects(relay.drain(), /redis unreachable/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get().n, 1)

  await relay.drain()
  assert.equal(published.length, 1)
  assert.deepEqual(JSON.parse(published[0].payload), { id: 1, title: 'retried' })
})

test('overlapping drains do not publish a row twice', async () => {
  // Two copies of one change carry two different event ids, so no client can dedupe
  // them — §2.1 dedupe is about replay, not about a relay that ran twice.
  const { db, published, relay } = boot()
  placeOrder(db, 'concurrent')

  await Promise.all([relay.drain(), relay.drain()])
  assert.equal(published.length, 1)
})

test('the origin survives the outbox, so the writing tab can skip its own echo', async () => {
  // §6.0. Without the origin column the echo arrives anonymous, and the tab that issued
  // the write applies it twice — once from the write's response and once from the
  // stream. It is not data loss, which is why it is easy to leave out and obvious in
  // the UI the moment somebody does.
  const { db, hub, relay } = boot()
  const acks = []
  const publish = hub.publish
  hub.publish = async (topic, payload, options = {}) => {
    acks.push(options.origin)
    return publish(topic, payload, options)
  }

  withOutbox(db, (emit) => {
    db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run('mine', 1)
    emit('orders', { id: 1 }, 'tab-7')
  })
  withOutbox(db, (emit) => {
    db.prepare('INSERT INTO orders (title, cents) VALUES (?, ?)').run('theirs', 1)
    emit('orders', { id: 2 })
  })

  await relay.drain()
  assert.deepEqual(acks, ['tab-7', undefined], 'carried when present, absent when not')
})
