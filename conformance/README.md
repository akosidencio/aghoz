# Conformance corpus

The shared test corpus for every implementation of the wire protocol. It is the contract
described in `PROTOCOL.md` §12, and it is the only reason having more than one hub
implementation is a defensible position rather than a slow-motion divergence.

This is the **hub's** corpus. The subscriber has its own — [`client/`](./client/) — for
the §9 rules a server cannot check for you, and [`http/`](./http/) covers the HTTP layer
above the core.

## Layout

```
vectors.json         the corpus — 97 vectors in nine groups
build-vectors.mjs    regenerates vectors.json
runner.mjs           runs the corpus against any JavaScript implementation
client/              the client corpus — §9, for subscriber implementations
http/                the HTTP suite — 42 scenarios over a real socket
```

The Rust side reads the same `vectors.json` from `core/tests/conformance.rs`, and the
same file runs against the Rust core through its Node binding via
`bindings/node/conformance-adapter.mjs`. **A vector added here is enforced on every
implementation automatically.** That property is the whole point; do not fork the corpus.

## Running it

```sh
node runner.mjs <path-to-module>          # any JS implementation
cargo test --release                      # from a Rust crate that reads the corpus
```

The runner exits non-zero and prints expected-vs-actual for every divergence.

## Groups

| group | count | covers |
|---|---|---|
| `encode` | 16 | §6.1 frame encoding, payload segmentation, §6.0 origin emission |
| `topic` | 16 | §3 topic validation |
| `origin` | 11 | §6.0 origin validation |
| `idOrder` | 4 | §2.1 id comparison |
| `idParse` | 21 | §2.1 which strings are canonical ids, and the 2^53−1 bound |
| `monotonic` | 3 | §2.2 clock-regression handling |
| `checkpoint` | 10 | §4.4 / §7.1 whether a reconnect is told it missed events |
| `append` | 9 | §2 / §4.5 the externally-assigned-id path a backplane needs |
| `buffer` | 7 | §8.2 the slow-consumer threshold, by absolute depth and by delta |

## Rules for adding vectors

**Write expected values from the spec, never capture them from an implementation.** A
corpus recorded from a running implementation only proves that implementation is
self-consistent. It cannot catch a bug both implementations would make, and it silently
blesses whatever the first implementation happened to do.

This is not hypothetical. The corpus's first run found a real divergence: **T15**. §3
bounds a topic at 255 **bytes**, but the JavaScript hub measured `topic.length`, which
counts UTF-16 code units. An 86-character Japanese topic is 258 UTF-8 bytes — rejected by
Rust, accepted by JavaScript. Had the corpus been captured from the JavaScript
implementation, the vector would have recorded `valid: true` and enshrined the bug.

Every vector should also carry a `desc` that explains what breaks if it fails. A vector
whose failure message does not tell you what is wrong is worth very little at 3am.

## Vectors that matter most

- **E2** — a payload containing a blank line must not be able to inject an `event:` or
  `id:` field. This is the injection defence; if it regresses, any user-supplied string
  reaching `publish` can forge events for every subscriber.
- **T7** — a topic named `~gap` must be rejected, or a publisher can forge data-loss
  notifications.
- **O6** — an origin containing LF must be rejected. Same attack as E2 and T7 through the
  §6.0 field, and the most exposed of the three: an origin is supplied by whichever client
  issued the write.
- **T15** — the byte/character distinction described above.
- **P19–P21** — the second real divergence the corpus caught, and the same shape as T15.
  §2 said "unsigned 64-bit", which no IEEE-754 host can represent: the Rust core accepted
  `18446744073709551615-0` and the TypeScript core refused it, so one cursor string named
  two different events depending on which implementation received it. Every language has
  its own wrong answer for "how big is an integer" too.
- **A3** — an out-of-order `append` must not drag the cursor backwards. Replay after a
  reconnect delivers older ids, and a cursor that rewinds replays events the client
  already applied — or, worse, lets a later local id collide with one already spent.
- **A7** — `encode` must record nothing. Its whole reason for existing separately from
  `append` is that shared-history replay would otherwise push duplicates into the local
  ring, out of id order, on every reconnect.
- **B1 / B2** — §8.2's threshold is strict, and it must be strict *both* ways of counting.
  An inclusive comparison disconnects a subscriber sitting exactly at its budget and doing
  nothing wrong; getting it right in one style and wrong in the other means the same
  traffic drops a subscriber in Python and not in Node.
- **B4** — an over-reported flush must saturate at zero. A count that underflows wraps to
  the top of the range, which reads as a perfectly healthy subscriber at the exact moment
  it is furthest behind — silent staleness reached from a different direction.
- **O1** — `1755083412345-7` sorts before `1755083412345-10`. A string comparison gets
  this backwards, and the failure mode is a client silently discarding live events as
  already-seen.
- **M1** — a backwards system clock must not produce a backwards cursor.
- **CP7** — an event too large for the whole history budget is evicted by the push that
  stored it, leaving history empty. An implementation that decides truncation by comparing
  against the oldest *retained* event has nothing to compare against and reports "nothing
  missed" for an event it definitely dropped. Silent staleness is the one failure §0 says
  must never happen, so this is the vector in the group worth keeping honest.
- **CP1** — the mirror image, and the one that erodes trust rather than data: `0-0` is the
  cold-start cursor §5 hands out, and it sorts below every real id. Compared against the
  oldest retained event it reports a gap on every first page load, which teaches people to
  ignore the signal.
