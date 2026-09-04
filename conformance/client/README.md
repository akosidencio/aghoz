# Client conformance corpus

The subscriber half of the protocol — PROTOCOL.md §9.

`../vectors.json` is the hub's corpus. It covers a client only by accident: the `encode`
vectors run in reverse, `idParse` and `idOrder` apply directly, and nothing in it pins a
single rule that only a client can break. This corpus is for those rules, and it exists
now rather than with v0.5's second client implementation because **v1.0 freezes the wire
format** and §9.3 was the rule that turned out to need a protocol change.

## Layout

```
vectors.json         the corpus — 14 vectors in one group
build-vectors.mjs    regenerates vectors.json
runner.mjs           runs the corpus against any JavaScript client implementation
```

```sh
node runner.mjs ../../packages/client/dist/conformance-adapter.js
```

## Groups

| group | count | covers |
|---|---|---|
| `cutover` | 14 | §9.3 which topics a cursor is a baseline for, and when a client must say it is not |

## Why a client corpus at all

Nothing on the wire distinguishes a client that reports a §9.3 cutover from one that
silently serves a topic it has no baseline for. The server sees one request with one
topic list; it cannot tell a newly added topic from an old one, and it has no way to be
wrong about it. The HTTP suite cannot catch this, the vector corpus cannot catch this,
and the failure is invisible in the UI — the component renders, with data that is missing
whatever was published while it was not subscribed.

That is the same shape as every bug the hub corpus has caught, and it is the reason this
file exists before there is a second client to run it against.

## Rules for adding vectors

**Write expected values from the spec, never capture them from an implementation.** The
same rule as the hub corpus, and the same reason: a corpus recorded from a running client
proves only that the client agrees with itself.

**Confirm a vector fails before letting it pass.** Both obvious wrong implementations were
run against this group first — the one that treats the cursor as a baseline for
everything, which is the pre-fix behaviour, and the one that reports every unseen topic,
which fires on every page load. The first fails 8 of 14 including K3; the second fails the
page-load cases. A vector that neither of them fails is not pinning anything.

## Vectors that matter most

- **K3** — the §9.3 interleaving itself: `b`'s event lands while the connection carries
  only `a`, and an `a` event carries the cursor past it. Everything else in the group
  bounds this one. If it regresses, a lazily mounted component renders data that is
  missing every event published before it mounted, and nothing reports it.
- **K1, K2, K4** — the other direction. A client that reports a cutover on a first page
  load makes every load a double fetch, and the signal gets switched off — which costs
  K3 as well, one step removed.
- **K5 / K6** — a topic dropped and re-added is covered only if the cursor stood still
  while it was gone. Treating "I had this topic once" as coverage loses exactly the
  events between the two connections.
- **K9** — a connection attempt that never opened must not consume the cutover. §9.4
  backs off through failures, and a signal discarded on a failed attempt leaves the topic
  permanently uncovered with nothing reported.
- **K14** — the cursor moves while nothing is subscribed (an idle client, or another tab
  on a shared connection). "Nothing was subscribed, so nothing was missed" is how a route
  change loses an event.
