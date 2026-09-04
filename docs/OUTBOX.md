# The publication boundary

**Gap detection starts after `publish` is accepted.** Everything before it — your
transaction, and the moment between committing it and telling the hub — is outside this
library, invisible to it, and where the failures nobody notices live.

PROTOCOL.md §8 makes two loss conditions impossible to hide: history the hub could not
keep, and a subscriber too slow to receive. Both are answered with a gap, and a client
that hears one refetches. Neither can be reported for an event that was *never published*,
because from the hub's point of view nothing happened at all. There is no hole in the
sequence to notice, no cursor that looks wrong, nothing to report — the stream stays
open, the checkpoint stays clean, and the UI is confidently out of date.

Documentation cannot fix that. A database commit and an event append are two operations
against two systems, and nothing in a README makes them atomic. This page is the pattern
that does, plus a runnable version of it in
[`examples/outbox-sqlite/`](../examples/outbox-sqlite/).

---

## The two wrong answers

Both of these are written every day, and each one is exactly half correct.

### Publish after the commit

```js
await db.query('INSERT INTO orders ...')   // committed
await hub.publish('orders', { id })        // ← the process can die here
```

The window between the two lines is small and it is not zero. A deploy, an OOM kill, a
pod eviction, an unhandled rejection three frames up — the order exists and no subscriber
will ever hear about it. Every connected client stays connected, receives every
subsequent event, and reports no gap: the stream is *complete*, and it is missing an
order.

This failure has no symptom. It is discovered when someone reloads the page and the
number changes.

### Publish before the commit

```js
await hub.publish('orders', { id })        // ← subscribers now believe this
await db.query('INSERT INTO orders ...')   // ← rolls back on a constraint violation
```

Worse, because it is unrecoverable by the mechanism that recovers everything else. A lost
event is fixed by a refetch; an invented event survives one, because the refetch agrees
with the database and disagrees with what every client was told. Clients that fold
payloads into state now hold a row that does not exist, and the only thing that clears it
is a full reload.

---

## The outbox

Write the event in the same transaction as the data. A relay reads the table and
publishes.

```sql
CREATE TABLE outbox (
  id       bigserial PRIMARY KEY,
  topic    text        NOT NULL,
  payload  jsonb       NOT NULL,
  sent_at  timestamptz            -- NULL until the hub acked it
);

CREATE INDEX outbox_unsent ON outbox (id) WHERE sent_at IS NULL;
```

```js
await db.transaction(async (tx) => {
  const order = await tx.query('INSERT INTO orders ... RETURNING id')
  await tx.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', [
    `org/${orgId}/orders`,
    JSON.stringify({ id: order.id }),
  ])
})
```

Either both rows exist or neither does. That is the whole idea, and it is the only part
that has to be exactly right.

The relay:

```js
for (const row of await unsentRows(limit)) {
  await hub.publish(row.topic, row.payload)          // assigns the event id
  await markSent(row.id)
}
```

Three rules, each of which is a bug if you get it wrong:

1. **Publish, then mark sent.** The other order is at-most-once, which is the loss you
   started out trying to close.
2. **One row at a time, in `id` order.** Publishing concurrently assigns ids in whatever
   order the awaits resolved, so two events written in one transaction can reach
   subscribers reversed.
3. **One drain at a time.** Two overlapping passes publish the same row twice, and the
   copies carry *different event ids* — §2.1 dedupe is about replay, so no client can
   collapse them.

`hub.publish` returns after the event has an id. With a backplane that means the shared
sequencer accepted it (§2.3), so a relay marking a row sent is recording a fact every
process agrees on rather than a local one.

### Waking the relay

Polling a local table on a short interval is not the polling this library exists to
replace: it is one process reading its own database, not every browser asking over the
network. It is also the least interesting part, and the easiest to improve later:

```sql
-- in the same transaction, after the outbox insert
NOTIFY aghoz_outbox;
```

A `LISTEN`ing relay wakes immediately and falls back to its interval, which is what keeps
a missed notification from becoming a stuck queue. Keep the interval even when the
notification works.

---

## Duplicates are the price, and they are cheap if you let them be

At-least-once means a subscriber can see the same logical change twice, under two
different event ids. Nothing downstream can dedupe that for you, so the payload design
decides how much it costs:

- **An event that says *what changed*** — a topic and an id, no state — costs a duplicate
  invalidation and one extra refetch. `@aghoz/react-query`'s `useTopicInvalidation` is
  idempotent by construction for exactly this reason, and it is why the event's payload
  is ignored there.
- **An event that says *what the new state is*** — a delta folded into a cache — costs a
  wrong number. `useTopicQueryData` folds, so a folding consumer needs an idempotency key
  in the payload (a version, a row id it can dedupe on) and an updater that checks it.

If you are unsure, publish the first kind. Refetching a query is the cheapest correctness
this library has.

---

## Change data capture, instead

CDC — logical replication, Debezium, `wal2json` — is the same boundary reached from the
other side: instead of writing a row saying what happened, you read the log the database
already writes. It removes the outbox table and the discipline of writing to it, and it
is a good answer when the writes come from services you do not own.

What it does not remove is the mapping. A WAL record says "row 918 in `orders` changed";
it does not know that this is `org/42/orders`, and it certainly does not know that a
change to `order_items` should invalidate the order it belongs to. That mapping is the
same code the `emit()` call was, moved somewhere with less context — which is the whole
trade. Two things follow:

- Derive the topic from columns that are actually in the row. A topic assembled from a
  join the CDC consumer has to perform is a second query per event, against the database
  you were trying to take load off.
- Filter tables explicitly, and fail loudly on an unmapped one. A CDC pipeline that
  silently ignores a table it has no rule for is a publication boundary that quietly
  stops publishing when someone adds a feature.

Ordering and at-least-once are unchanged: replication slots redeliver after a restart, so
everything in the section above still applies.

---

## What the writing client sees

The relay is asynchronous, so the write's HTTP response cannot carry the event's id — it
does not exist yet. Do not try to make it: waiting for the relay inside the request makes
the outbox exactly as slow as publishing inline and gives back none of what it bought.

The tab that issued the write already has the authoritative answer in the write's own
response. What it needs is not to apply that answer twice when the echo arrives, which is
§6.0's `origin`: send `client.originId` with the mutation, store it in the outbox row
beside the topic and the payload, and hand it back at publish time.

```js
emit(topic, payload, req.headers['x-origin'])        // into the outbox row
await hub.publish(row.topic, row.payload, { origin: row.origin })   // in the relay
```

The writing tab skips its own echo while still advancing its cursor. Every *other* tab,
and every other user, learns about the write from the stream in the ordinary way.

---

## Operating it

- **Alarm on the age of the oldest unsent row**, not on its count. A count spikes under
  ordinary load and says nothing; an age says the relay is stuck, which is the only
  outbox failure that matters. It is also the one failure mode this pattern introduces:
  a stuck relay is silent to subscribers, exactly like the crash window it replaced,
  which is why the alarm is not optional.
- **Keep `sent_at` and prune on a schedule.** A boolean loses the fact that makes a
  stuck relay visible.
- **One relay.** Two relays are two concurrent drains with the same consequence as
  re-entrancy, one process further away. If you need more than one for throughput,
  partition by topic and give each partition a single writer — the same shape as
  PROTOCOL.md §2.4's feed scopes, for the same reason.
- **Watch the retention budget.** A relay that was stopped for an hour publishes an hour
  of events at once, and the hub's history — `maxHistoryBytes`, or the backplane's
  `maxLen` — is the thing that decides whether resuming clients get a replay or a gap.
  A burst that overruns it degrades to a refetch storm, which is safe and expensive.

---

## The runnable version

[`examples/outbox-sqlite/`](../examples/outbox-sqlite/) is this page as ninety lines of
code and eight tests, using `node:sqlite` so it needs no database to run:

```sh
cd examples/outbox-sqlite
node --test test/*.mjs        # the crash window, the rollback, the retry, the ordering
node server.mjs               # a real application with the boundary wired
```

The test named *"a crash between the commit and the publish loses nothing"* is the one
worth reading first. It is the failure this whole page is about, and it is four lines
long.
