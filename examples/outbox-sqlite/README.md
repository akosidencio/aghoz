# The publication boundary, executable

Gap detection starts *after* `publish` is accepted (PROTOCOL.md §8). The window before
it — your transaction, and the moment between committing it and telling the hub — is
invisible to this library, and an event lost there is lost with no gap, no error and no
symptom.

This example closes it with a transactional outbox, in plain `node:http` and
`node:sqlite`, with no third-party dependencies. The reasoning is in
[docs/OUTBOX.md](../../docs/OUTBOX.md); this is the part you can run.

```sh
node --test test/*.mjs     # the boundary as nine tests
node server.mjs            # a real application with it wired in
```

Then, in another terminal:

```sh
curl -N 'http://127.0.0.1:3412/events?topics=orders' &
curl -X POST http://127.0.0.1:3412/api/orders \
  -H 'content-type: application/json' \
  -d '{"title":"a book","cents":1200}'
```

## What to read

| file | what it shows |
|---|---|
| `outbox.mjs` | `withOutbox` — the event written in the same transaction as the data — and the relay that drains it |
| `server.mjs` | the wiring: a hub, a relay, a `POST` that commits, and `event-cursor` on the read (§5) |
| `test/outbox.test.mjs` | the crash window, the rollback, ordering, retries, and the two ways a relay publishes twice |
| `test/e2e.test.mjs` | the whole path over a real socket, from `POST` to a delivered frame |

The test named *"a crash between the commit and the publish loses nothing"* is the
point of the example. Everything else bounds it.

## What this is not

SQLite is here because it is built into Node and needs no setup. The pattern is the same
on Postgres or MySQL; on Postgres, add `NOTIFY` in the same transaction so the relay wakes
immediately instead of on its interval, and keep the interval anyway — a missed
notification must not become a stuck queue.

The relay polls a local table every 50 ms. That is one process reading its own database,
not every browser asking over the network, which is the polling this library replaces.
