/**
 * The transactional outbox, in about ninety lines.
 *
 * PROTOCOL.md §8 makes two loss conditions impossible to hide, and both of them start
 * *after* `publish` is accepted. Everything before that — the database commit, the
 * process that dies between the commit and the publish — is outside the hub entirely,
 * and no amount of gap detection can see into it. This file is the part of the story
 * the library cannot ship for you, written down as code so it can be run rather than
 * agreed with.
 *
 * The rule it implements: **the event is written in the same transaction as the data.**
 * A relay reads the outbox and publishes. See ../../docs/OUTBOX.md for why the two
 * obvious alternatives — publish after the commit, publish before it — each lose or
 * invent events, and for the CDC variant of the same idea.
 */

import { DatabaseSync } from 'node:sqlite'

/**
 * Schema for the demo. Two tables and the discipline that connects them.
 *
 * `outbox.id` is an autoincrementing integer and it is the relay's ordering, not the
 * event id: the event id is assigned by the hub (or by the backplane's sequencer) at
 * publish time, which is the only place that can assign one that every process agrees
 * on. §2.3.
 */
export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      title  TEXT NOT NULL,
      cents  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      topic     TEXT NOT NULL,
      payload   TEXT NOT NULL,
      -- §6.0. The tab that issued the write has already applied the write's own
      -- response, so it must skip its own echo — and it can only do that if the origin
      -- survives the trip through the table. Dropping it here is a double render in
      -- exactly the tab that acted, which reads as a bug rather than as a lost origin.
      origin    TEXT,
      -- NULL until the relay has an ack. Not a boolean: knowing *when* is what makes a
      -- stuck relay visible, and a stuck relay is silent by construction.
      sent_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS outbox_unsent ON outbox (id) WHERE sent_at IS NULL;
  `)
  return db
}

/**
 * Runs `fn` inside one transaction and records the events it asks for.
 *
 * `fn` receives an `emit(topic, payload)` that appends to the outbox rather than
 * publishing. Nothing reaches the hub from in here, deliberately: a publish inside a
 * transaction that later rolls back is an event for something that never happened, and
 * unlike a lost event nobody can refetch their way out of one.
 */
export function withOutbox(db, fn) {
  const pending = []
  const emit = (topic, payload, origin) => {
    pending.push([
      topic,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      origin ?? null,
    ])
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(emit)
    const insert = db.prepare('INSERT INTO outbox (topic, payload, origin) VALUES (?, ?, ?)')
    for (const [topic, payload, origin] of pending) insert.run(topic, payload, origin)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Drains the outbox into a hub, oldest first.
 *
 * At-least-once, and it has to be: the row is marked sent only after `publish` resolves,
 * so a crash in between republishes on the next pass. The alternative ordering — mark
 * first, publish second — is at-most-once, which is the loss this whole file exists to
 * close.
 *
 * Duplicates are therefore the cost, and they are cheap in the right design: an event
 * that says *what changed* rather than *what the new state is* costs a duplicate
 * invalidation. `@aghoz/react-query`'s `useTopicInvalidation` is idempotent for exactly
 * this reason; `useTopicQueryData`, which folds payloads, is not, and a folding consumer
 * needs its own idempotency key in the payload.
 */
export function createRelay({ db, hub, batch = 100, onError = () => {} }) {
  const unsent = db.prepare(
    'SELECT id, topic, payload, origin FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?',
  )
  const markSent = db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?')
  let running = false

  /** One pass. Returns how many rows were published. */
  async function drain() {
    // Re-entrancy would publish the same rows twice from two overlapping passes, and
    // the second copy carries a *different* event id, so no client can dedupe it.
    if (running) return 0
    running = true
    try {
      let published = 0
      for (;;) {
        const rows = unsent.all(batch)
        if (rows.length === 0) return published
        for (const row of rows) {
          // Serial on purpose. Concurrent publishes would assign ids in whatever order
          // the awaits resolved, so two events written in one transaction could reach
          // subscribers reversed.
          await hub.publish(
            row.topic,
            row.payload,
            row.origin === null ? {} : { origin: row.origin },
          )
          markSent.run(Date.now(), row.id)
          published++
        }
      }
    } finally {
      running = false
    }
  }

  let timer
  return {
    drain,
    /**
     * Polls every `intervalMs`.
     *
     * Polling a local table is not the polling this library replaces: it is one process
     * reading its own database on a short interval, not every browser asking over the
     * network. A production relay usually wakes on a NOTIFY or a queue instead; the
     * shape of `drain` does not change.
     */
    start(intervalMs = 50) {
      if (timer !== undefined) return
      timer = setInterval(() => {
        drain().catch(onError)
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
