# Decision record

Decisions that are expensive to reverse, with the evidence that produced them.
Newest first.

---

## D18 — The bounds that only held on the string path, and an ABI that admits it is unsafe

**Date:** 4 September 2026 · **Status:** accepted

### Three rules that were enforced in one place each and assumed everywhere else

A Rust audit against the official guidance turned up four defects with one shape: a rule
this project states clearly, enforced at exactly one of the paths that can break it.

**`cargo clippy` had never run in CI.** Twenty-eight *deny-by-default* errors were
waiting, all of them `not_unsafe_ptr_arg_deref`: every entry point in `abi/` was a safe
`extern "C" fn` that dereferenced a caller's pointer. The crate builds as an `rlib` as
well as a `cdylib`, so "the caller is C" is a convention, not something the compiler
knows — safe Rust could call `ag_publish(garbage, ..)` and reach undefined behaviour with
no `unsafe` written anywhere. `lib.rs` opens by saying all of the unsafe lives in that
file and nothing hides inside a signature; the signatures said otherwise.

**§2's 2^53 − 1 bound held only for ids that arrived as text.** `EventId` had public
fields, so `EventId { ms, seq }` skipped `parse` entirely — and the numeric paths are
real ones: `ag_subscribe` assembles a cursor from two `uint64_t`s, and every `publish`
takes `now_ms` from the host's clock. A binding reporting nanoseconds — the way this
mistake actually happens — lands two orders of magnitude past the bound. Measured, on the
pre-fix build:

```
h.append(EventId { ms: u64::MAX, seq: u64::MAX }, ..)   → Ok
h.publish(1000, ..)   debug:   panicked, 'attempt to add with overflow'
                      release: id = 18446744073709551615-0   ← the cursor went backwards
```

The release line is the one that matters: a cursor below every id a client already holds
reads as "nothing new", forever, with nothing reported.

**Subscriber ids were truncated to `u32` crossing into Node.** `registry.rs` explains at
length that a recycled id "lets a write scheduled for a closed subscriber land on whoever
inherited the number — a cross-tenant leak that would be near-impossible to reproduce",
and `as u32` reintroduced exactly that at 2^32 subscribes: `create-hub.ts` keys its
`connections` map by that number, so subscriber 4294967297 collides with subscriber 1 and
inherits its fan-out. The TypeScript core, using JavaScript numbers throughout, does not
wrap — so the two cores disagreed about their own core invariant.

**`~denied` could be made unparseable.** `json_string` escaped `"` and `\` only,
documented as safe because §3 forbids control characters in a topic. §3 is enforced on
*subscribe*; `denied_frame` takes whatever list a binding hands it. A topic with a raw LF
forged nothing — `write_data_lines` splits it onto another `data:` line — but the client
rejoins those lines with a newline, so `JSON.parse` threw on the one frame that names
which topics were refused.

### Decision

**Every ABI entry point that takes a pointer is `pub unsafe extern "C" fn`, with a
`# Safety` section stating its contract.** No symbol changes, no C declaration changes,
`aghoz.h` is untouched apart from prose. `with_hub` now takes `Option<&ag_hub>` so the
pointer half is one line per entry point and the lock and panic boundary contain no
unsafe at all — the alternative, passing the raw pointer down, put each closure body
*inside* an `unsafe` block, which makes the blocks it writes for its own dereferences
redundant and therefore unwritten. All 42 unsafe blocks carry a `// SAFETY:` comment.

**`EventId`'s fields are private.** The ways in are `parse` and the new `new(ms, seq) ->
Option<EventId>`, and both refuse anything above `MAX_ID_COMPONENT`. `Sequence::next`
returns `Option` and stops at the bound rather than stepping over it. A publish that
would leave the range is `PublishError::IdOutOfRange` and assigns no id.

That maps to `AG_ERR_MALFORMED_ID` rather than a new status, so **the ABI stays at
3200**. It is the same rule being broken — `ag_append("9007199254740992-0", ..)` already
returned it — and a new code would be a major bump under D3's own reasoning while saying
nothing a caller could act on differently. `ag_publish` and `ag_subscribe` can now return
it and could not before; both are documented, and the codes they returned before are
unchanged.

**Subscriber ids cross into JavaScript as `f64`.** Exact to 2^53, which is the bound §2
already puts on an event id, and `number` in the `.d.ts` either way — the seam does not
change shape. `json_string` escapes the whole control range, so a `~denied` frame is
parseable whatever a binding puts in it.

**The TypeScript core takes the same bound**, in `Hub#nextId`, because a cursor one core
hands out that the other refuses is worse than either behaviour on its own.

### The gate that would have caught all of it

`clippy --all-targets -- -D warnings`, `fmt --check`, `doc` with warnings denied, and
`cargo deny` now run in CI beside the tests and Miri. The lint policy lives in
`[workspace.lints]`, and the security-relevant half of it — the casts, the arithmetic,
the panicking accessors — is warned on everywhere; where a site is provably in range it
takes an `allow` with the proof written next to it, which is the point. `release` builds
with `overflow-checks = true`: an overflow here is a protocol violation, and shipping the
wrapping behaviour while testing the trapping one is two behaviours from one source.
`rust-toolchain.toml` pins the toolchain, and `rust-version` records the floor — 1.88,
set by `napi-build`, not by anything this code does.

---

## D17 — Cross-origin authentication is connection configuration, not protocol data

**Date:** 18 August 2026 · **Status:** accepted

### The first production host is not same-origin

Mounting Aghoz inside an application's API preserves its authentication and authorization,
but it does not imply that every browser is served from the API's origin. Reko has two web
applications connecting to a separate NestJS API. The original client inherited fetch's
`same-origin` credentials default and offered no application headers, so neither its cookie
session nor a rotating bearer token could reliably authenticate that stream.

Putting a token in the URL would make it appear in browser history, access logs and proxy
telemetry. Requiring every caller to replace `fetch` for a normal authentication concern
would also turn reconnect and cursor behaviour into application code.

### Decision: credentials plus reconnect-aware headers

`createClient` and `createSharedClient` accept `credentials` and `headers`. Headers may be a
static `HeadersInit` or an async factory evaluated for every connection attempt, so a bearer
token refreshed while the old stream was open is read again on reconnect. React, Vue and
Svelte forward the same options from their root providers.

The protocol owns `Accept: text/event-stream` and `Last-Event-ID`; application headers cannot
override them. The URL cursor fallback remains, but it is not an authentication channel.
Cookies use `credentials: 'include'`; bearer and API-key clients use the header factory.

CORS stays the host application's responsibility. A credentialed deployment must name exact
web origins, allow its authentication headers and `Last-Event-ID`, and expose
`Last-Event-ID-Checkpoint`. Aghoz documents that contract because omitting the checkpoint
header turns a detectable replay gap into one the browser cannot inspect.

### Runtime scope

Node 22+ remains the supported server runtime. Bun 1.3.14 is a compatibility target for the
first NestJS deployment, gated in CI by the complete HTTP corpus and focused Nest/Redis smoke
tests. This is an explicit production canary, not a claim that every Bun release is supported.

The hub owns the backplane lifecycle. This matters for the Nest async module: it can create
the Redis backplane inside its factory, where application code never receives a separate
handle. `hub.close()` therefore closes the blocking Redis reader as well as subscribers and
timers, so a deployment shutdown cannot leave the process alive behind Nest.

---

## D16 — The product is an edge event stream, not Kafka for browsers

**Date:** 18 August 2026 · **Status:** accepted

### The analogy found the right mechanics and the wrong consumer

Aghoz has topics, a monotonic position, bounded history, replay and an explicit answer
when a position falls outside retention. Those are log-shaped mechanics, so "Kafka
between server and browser" is a useful design prompt.

Taken literally, it promises the wrong system. Kafka consumers have partition offsets,
consumer-group membership and acknowledgements or committed positions. Aghoz has one
ephemeral UI connection, advances its cursor when a frame is received, and deliberately
does not wait for application handlers to succeed. Giving every browser tab or phone a
durable broker consumer would also move untrusted-client authentication, offset expiry
and device lifecycle into the broker — the complexity mounting inside the application
exists to avoid.

### Decision: Kafka-like replay inside an application-owned edge

The category is **resumable, authorized edge event stream**. The application database and
ordinary APIs remain the source of truth. Aghoz carries low-latency invalidations or
events to active UI clients, using the host's authentication, and either replays accepted
events after interruption or tells the client to read a fresh snapshot.

Kafka, NATS, Redis Streams, an outbox or CDC may sit behind that edge. They are internal
durability and fan-out mechanisms, not browser transports. The distinction preserves the
small in-process on-ramp while leaving a durable ingestion path available when a database
commit must not outrun publication.

The delivery claim stops at explicit boundaries:

- gap detection covers events the hub or backplane accepted, not a commit that was never
  published;
- the cursor means a frame was received, not that every application handler completed;
- browser and mobile clients are ephemeral observers, not durable consumer groups; and
- direct event folding is an optimization, while snapshot invalidation is the safe
  default.

### Mobile is two transports sharing one recovery model

A foreground native client can hold the same streaming HTTP response as a browser. A
backgrounded app cannot own liveness; iOS and Android may suspend it regardless of the
socket. APNs or FCM therefore carries only a wake-up hint. On resumption the client uses
its persisted cursor, replays what retention still covers, and refetches when it does not.

The push notification is allowed to be delayed, coalesced or lost because it is never the
authoritative event log. Foreground streaming and background push are different delivery
paths with the same snapshot-based recovery rule.

### Consequences before the protocol freeze

The reframe exposes two design questions that a global cursor had hidden. A cursor built
while subscribing to `a` does not establish initial state for a lazily added `b`, and one
global Redis stream makes every tenant share retention and replay work. Topic-set cutover
and partitioned cursor semantics are therefore freeze gates, not adapter details. They are
tracked in PROTOCOL.md §13 and the README roadmap.

---

## D15 — A lock handoff conveys one bit, so the tab registry is rediscovered rather than inherited

**Date:** 16 August 2026 · **Status:** accepted

### The hole D11's own mutation table walked past

D11 lists four deliberate breaks and the scenario that catches each, and the third is
*"leader subscribes to its own topics, not the union"*. A promoted leader did exactly that,
and no scenario caught it — because every failover test used tabs with identical topic
sets, where a union of one is indistinguishable from the union of all.

Three tabs, three topics, kill the leader:

```
before:  alpha→tab A (leader)   beta→tab B   gamma→tab C     all delivered
after:   B promoted, union = {beta}
         publish gamma  →  tab C receives nothing, state 'open', no gap, no error
```

Tab C keeps its state, its cursor and its callbacks. It simply stops receiving. Silent
staleness, reintroduced by the feature whose entire justification was saving connections —
the same shape D11 rejected heartbeat elections for, arriving through the door D11 opened.

### Why the registry cannot be inherited

Who-wants-what lives only in the leader. Nothing in a Web Lock handoff carries it across,
and that is the property D11 was bought for: the lock conveys leadership and nothing else,
which is why there is no election protocol to get wrong. The alternatives to rediscovery
are all worse — a registry mirrored into `localStorage` needs its own expiry story for tabs
that crashed, and a leader that inherited the old map would inherit its ghosts.

### Decision: the new leader announces, every tab answers

One message type, `lead`, and it is the only one broadcast rather than addressed. Tabs
answer with the `hello` they already send at construction, so the leader side needs no new
handler and the reply path — `welcome`, which re-syncs the answering tab's state and cursor
with whoever holds the stream now — is the one that was already there.

Rebuilding from the answers rather than pruning a map is what makes it correct without a
timeout: **a tab that has gone away cannot answer.** Liveness is established by the same
mechanism that establishes leadership, rather than by a second one that would need its own
tuning.

The union widens after the connection has already opened, which reconnects with the cursor
the tab has been tracking all along (§9.3) — so events for another tab's topic that arrived
inside that window are replayed, not skipped. The same trade the handoff itself makes.

It closes a second hole in passing: a tab that announced itself before any leader existed
was invisible until it next subscribed. It now answers the first `lead` like any other.

### Verified by the test that was missing

*a promotion keeps the topics of the tabs that did not move* — three tabs, three distinct
topics, and an assertion that the bystander is still receiving after the leader dies. It
fails against the previous build, which is the only reason to trust it.

---

## D14 — `hub.cursor()` answers for the sequence, and with a backplane the sequence is shared

**Date:** 16 August 2026 · **Status:** accepted

### A cluster's newest worker was the one that could not answer

`cursor()` returned `core.cursor()` — this process's ring — while `Backplane.cursor()`, the
shared sequence's own answer, existed and was called by nothing. On a worker that had just
started, the ring is empty and the reader has delivered nothing:

```
worker A, up for hours, 2000 events published:  hub.cursor() → 1786884537731-0
worker B, started just now:                     hub.cursor() → 0-0
page bootstrapped by B, stream opened with 0-0: truncated, 0 events  → ~gap, full refetch
```

Every page a fresh worker bootstraps is told it lost the history it never had — for the
length of a rolling deploy, that is every page. The same false alarm D12 and D13 fixed, let
in through a third door: not a history that lied, but a *cursor* that described one process
where the client needs the deployment.

### It was never the dangerous direction, and that decided the fix

A cursor behind the sequence costs replay; one ahead of it costs events. This can only ever
be behind — every id the core holds came out of the shared log, and with a backplane
configured there is no local id assignment to overtake it. So the fix does not need to be
exact, only bounded: **seed the cursor at boot from `backplane.cursor()`**, folded into the
existing `ready()` promise, which already exists for the same reason and is already awaited
by the handler. Staleness goes from "everything since this process started" to "the reader's
round trip", with no IO on the request path and no change to a sync `cursor()` that a dozen
documented call sites use.

`ready()` therefore never rejects, now that a network call is inside it. A backplane that
cannot be reached at boot leaves the cursor at `0-0` and the hub serving — a rejection would
take out every request through the handler that awaits it, to protect one cursor.

### Where exactness is worth a round trip

Two places take it: **`sharedCursor()`**, for a hand-rolled bootstrap that stamps a cursor
next to data it just read, and **`cursorHandler()`** — §5's own endpoint, which is reached
for precisely by applications that have not thought about which process is answering.

The residual window the seed leaves is real: an event published on another worker in the
last millisecond is in your database snapshot before it is in this worker's reader, so a
client replays it on top of a snapshot that already reflects it. That is a duplicate
application, not a loss, and it is inherent to any cursor read before its data — which is
why the choice is documented at the call site rather than decided for everyone.

### PROTOCOL.md §5 was ambiguous, and said so only by implication

"The newest id currently assigned" reads as a per-process claim to anyone implementing the
endpoint in a language whose deployment is multi-worker by default — which is every adapter
after Node. Spelled out, with the direction to err in when exactness is not available.

---

## D13 — The Redis backplane cannot answer the loss question from the stream alone, so it keeps one durable fact beside it

**Date:** 16 August 2026 · **Status:** accepted

### The same bug as D12, one level out

D12 fixed the in-process ring. The shared log had the identical hole, and the Redis
backplane's replay was answering it with the rule §4.4 exists to forbid — comparing the
cursor against the **oldest retained** entry:

```
cold start, nothing ever trimmed:  replay('0-0')  →  truncated: true   + 2 events
stream deleted under the cursor:   replay(id)     →  truncated: false  + 0 events
```

Both wrong, in opposite directions, and the second is the one that matters: a `DEL`, a key
expiry, a `maxmemory` eviction, or a failover onto a replica that never received the writes
all leave the stream with no oldest entry to compare against — and the code read "nothing
retained means nothing can have been missed from it", so every reconnecting client was told
it was up to date. Silent staleness, the one failure §0 exists to eliminate, on exactly the
deployments a backplane exists to serve. The first is merely expensive: a `~gap` on every
first page load, arriving beside the complete replay that disproves it.

### Why the hub's fix does not port

D6's rule needs the newest **evicted** id. The hub owns its ring and records it on the way
out. Redis trims implicitly inside `XADD` and reports nothing, so that id is not
observable, and no amount of reading the stream afterwards recovers it — the entries that
would name it are the ones that are gone. D12's second rule, `cursor > newest`, does port
and is carried over unchanged; it is what catches a stream that was rebuilt under the same
key, or a replica promoted without the tail.

What is left unanswerable is the pair the two failures above turn on: *has anything ever
been evicted from this stream at all?* That needs one fact the stream does not carry.

### Decision: a floor marker, in Redis, written once

`<key>:floor` — a plain string, `created:<id>` or `adopted:<id>`, `SETNX` so the earliest
observer's account is the one that stands.

`created` is the load-bearing half, and only a process that found the stream **empty** and
then wrote its first entry may claim it — checked, not assumed: the id it added must also
be the oldest the stream holds, so a publish that raced in behind another process records
`adopted` instead. A `created` floor still equal to the oldest retained entry is the proof
that nothing has ever been dropped, and it is what licenses echoing `0-0`. `adopted` is
what any process starting mid-life records, and it vouches for nothing: entries may have
gone before anyone here was looking.

Costs one round trip on a process's first publish, awaited rather than fired off — a marker
lost to a failed round trip would leave the stream unable to vouch for itself for the rest
of its life, and no later publish would know to retry. Reads are free of it in the steady
state: the marker is read only during replay, beside reads that were already happening.

### What is accepted rather than solved

**A cursor sitting exactly on the last evicted id** is reported as a gap, where §4.4 says to
echo it. The floor proves that *something* was evicted, never *what*, so the retained edge
is the only watermark available. It is a one-entry-wide false alarm costing one refetch,
and over-reporting is the direction to be wrong in.

**A `created` claim can be lost to a race at the stream's birth** — a second process
constructing inside the ~2 round trips between the first `XADD` and its `SETNX` records
`adopted`, and the deployment spends the stream's life answering conservatively. Closing it
needs the marker written before the id it names exists, which is a `Lua` script, which is a
command the injected-client interface deliberately does not require. Wrong in the safe
direction, and self-describing when it happens: the key says `adopted`.

**`get`/`setnx` are optional on `RedisLike`.** An adapter without them degrades to
answering "you may have missed something" in precisely the two cases the marker resolves,
which is what the interface's whole no-runtime-dependency premise is worth paying for. It
does not degrade to silence: the `cursor > newest` half needs no marker, so a destroyed
history is still reported to every client holding a real cursor.

---

## D12 — A restarted hub was silently lying, and persistence is the optimisation on top of the fix

**Date:** 16 August 2026 · **Status:** accepted

### The bug under the roadmap item

v0.4 listed "persistent history — a disk-backed ring, so replay survives a restart" as an
efficiency item. Probing the behaviour it was meant to improve found something else:

```
life 1: publish 1786880895872-0, publish 1786880895873-0, process dies
life 2: client reconnects with last-event-id: 1786880895872-0
        →  last-event-id-checkpoint: 1786880895872-0
```

An `echo`. The hub told a resuming client **it had missed nothing**, while the event
published just before the shutdown was gone for good. That is silent staleness — the one
failure §0 exists to eliminate — on every restart of every deployment, and it had been
there since v0.1.

The cause is that D6's rule is one-sided. `truncated = last_trimmed !== null && cursor <
last_trimmed` asks "did I drop something you had not seen?", and a restarted hub has
dropped nothing *because it remembers nothing*. An empty ring and a fresh install are
indistinguishable from the inside.

### The fix, which needs no configuration

A cursor is also unvouchable from the other end: **newer than every id the hub has ever
issued or recorded.** A hub that has never seen an id that high cannot know what came
after it, and in normal operation this never fires, because a client's cursor is by
construction an id this hub handed out.

```
truncated = evicted || cursor > hub.cursor()
```

Two lines, in both cores, and it costs nothing. Crucially it leaves D6's false-positive
protection intact: `0-0` against a hub that has published nothing is still `echo`, because
`0-0` is not greater than `0-0`. Three vectors pin it — **CP8** (the restart case), **CP9**
(a cursor exactly at the newest id is not a gap), **CP10** (a real cursor against an empty
hub). Verified to fail against the old rule first.

One existing test asserted the opposite — *"an empty hub cannot report truncated — there
is nothing to have lost"*. That is the wrong intuition and it is what hid the bug: an
empty hub having nothing does not mean the *client* lost nothing, it means the hub cannot
tell. Rewritten, with the cold-start half kept beside it so the D6 protection stays pinned.

### Persistence, now an optimisation rather than a patch

With the above, a restart is *correct* — every client is told, and refetches. What
persistence buys is that they do not all have to: a store turns a thundering herd on every
deploy back into an ordinary replay.

**It cannot live in the core.** The core performs no IO, by enforced invariant, and that
is what lets one Rust implementation serve every language (D3). So `HistoryStore` sits at
the handler layer beside `Backplane`, and restores through `core.append` — which exists
only because the backplane needed the same thing. `@aghoz/history-file` is the file-backed
implementation, and the tenth package.

**Mutually exclusive with a backplane**, which is refused at construction. A Redis stream
already *is* a persistent shared history, so a store alongside one would be written to
forever and never read — durability in appearance only.

### What building it found

**A bounded store creates the same hole one level down.** Compaction throws away the
oldest events, and the hub's ring knows nothing about a file compacted before boot — so it
echoed a cursor whose events the store had discarded. Only the store knows, so `load()`
now returns `{ events, trimmed? }`, and the file store persists that marker as a header
line in the compacted log because it cannot be recomputed once the lines are gone.

**Honouring that floor required `compareIds` on the seam.** The handler layer had no way
to compare two ids at all, and §2.1 forbids doing it as strings. Added to `HubCore`, and
to the C ABI as `ag_compare_ids` (**3200**, minor and additive) — without it a non-Node
adapter implementing a store would have had to reimplement the one comparison the corpus
exists to keep identical, which is exactly the trap ADAPTERS.md warns about.

**`close()` cannot be awaited, and a durability feature needs that.** `hub.close()` is
synchronous by contract and does not await the store, so queued writes were still in
flight when the process moved on. Rather than make shutdown async and change every caller,
the store's own `close()` is the documented graceful-shutdown hook — `hub.close(); await
store.close()` — and double-closing is explicitly safe so that pattern works. Found by a
test that stat'd the log too early.

**A first version of the file store dropped writes on close**, because the queued
continuation re-checked a `closed` flag set behind it. Only *new* appends are refused now;
`close()` drains the queue rather than racing it.

### The tail is deliberately allowed to be lost

The file store does not fsync per event by default, and that is a decision rather than an
omission: **losing the tail cannot cause silent staleness.** A hub restored from a short
log has a cursor behind the client's, and the rule above reports that as a gap. Durability
here buys fewer refetches, never correctness, so paying an fsync per publish to buy nothing
is the wrong default. `fsync: true` is there for an operational story that wants it anyway.

---

## D11 — The multi-tab leader is whoever holds a Web Lock, not whoever wins an election

**Date:** 16 August 2026 · **Status:** accepted

### The roadmap said BroadcastChannel leader election. It should not.

Five tabs is five connections, five replay scans per reconnect, and five of the browser's
six HTTP/1.1 slots. Sharing one connection needs two things: a way to decide which tab
holds it, and a way to fan out. `BroadcastChannel` is right for the second and wrong for
the first.

A `BroadcastChannel` election is a heartbeat: the leader announces itself on an interval,
and the others assume it is dead after some timeout. **Both ends of that timeout are
bad**, and the bad end is worse here than in most products:

- **Too short** and a garbage-collect pause or a backgrounded tab elects a second leader.
  Two connections, both live, both forwarding — the same event delivered twice from two
  sockets, which no client-side dedupe fixes because both are legitimately new to
  somebody.
- **Too long** and every tab is blind for the timeout after a crash. That is silent
  staleness — the one failure §0 exists to eliminate — reintroduced by a feature whose
  entire justification was efficiency.

There is no value of the timeout that avoids both. The choice is which failure to have.

### Decision

**The leader is whoever holds an exclusive Web Lock.** Every tab calls
`navigator.locks.request(name, { mode: 'exclusive' }, () => new Promise(() => {}))` — a
callback that never settles, so the lock is held for the tab's lifetime. The browser
grants it to one, queues the rest, and hands it to the next in line the moment the holder
goes away, **including on a crash or a force-quit that runs no unload handler.**

So there is no election protocol in this codebase at all. No heartbeat, no timeout, no
split-brain window, and no promotion code — a queued tab's pending `request` simply
resolves. `BroadcastChannel` is left doing the one job it is good at: moving frames
between tabs.

**Where `navigator.locks` is missing, `createSharedClient` throws** rather than falling
back. Degrading to one connection per tab is correct and boring; degrading to a guessed
timeout is neither, and a fallback nobody tests is worse than an error message. Web Locks
is in every browser this library targets.

### Handoff, which is where the correctness actually lives

A promoted tab must not resume from "now" — that loses whatever was published while no tab
held the stream, with nothing reported. So **every tab tracks the cursor of every
forwarded event, whether or not it has a handler for that topic.** A tab promoted to
leader already knows where the shared stream reached and resumes from there; the server
replays the rest.

Two consequences worth stating:

- **The shared connection is a pure transport.** Its inner `Client` is constructed with a
  random `originId` no tab uses, so it filters nothing. §6.0's "skip your own echo" is a
  per-tab decision — a follower's echo has to reach it in order to be skipped *there* —
  and a leader that filtered in transport would silently deny every other tab an event.
- **Every tab dedupes.** Not a formality: a tab reloaded a moment ago holds a fresher
  cursor than a leader open for hours, so the leader's replay forwards events that tab has
  already applied.

### Verified by breaking it

Four deliberate breaks, each caught by the scenario that should catch it:

| break | caught by |
|---|---|
| promoted leader does not resume from the shared cursor | *an event published while no tab holds the stream is replayed* |
| inner client uses the leader tab's own origin | *the origin skip works when the leader itself is the writer* |
| leader subscribes to its own topics, not the union | *the leader subscribes to the union* (and the widening test) |
| followers stop deduping | *a tab further ahead than the leader skips what the leader replays* |

The fourth is the one worth recording, because the first version of that test **did not
catch it**. It killed a leader and asserted no duplicates, but the promoted tab resumed
from a cursor the server had nothing newer than, so no duplicate was ever produced and the
dedupe path went unexercised. A test that cannot fail is not coverage. The replacement
constructs the situation that genuinely produces one — a follower ahead of its leader.

The handoff test had the mirror problem: it slept 30 ms and published, intending to hit a
window where no tab held the stream, but promotion usually won that race and the event
arrived live. It now makes the window deterministic by promoting a tab with no topics,
which opens no connection at all.

### Also fixed while building it

`SharedClient` opened its `BroadcastChannel` *before* validating `navigator.locks`, so the
throw left a channel nobody held a reference to and nobody could close — which in Node
kept the event loop alive forever, and in a browser would leak one per attempt. Order
reversed. The channel is also `unref`'d where the runtime supports it, matching what the
client already does for its timers.

---

## D10 — §8.2 gains a delta-counted backpressure path, reversing an earlier objection

**Date:** 16 August 2026 · **Status:** accepted · **Amends:** the `note_buffer` rationale

### What was there, and why it was not enough

`note_buffer(id, queued_bytes)` takes the socket's **absolute** outstanding depth, and its
comment argued against the alternative in one line:

> Absolute depth rather than deltas, because the socket is the only thing that knows what
> is truly outstanding, and add/subtract accounting drifts the first time a write is
> partially flushed.

That is correct, and it is correct about Node specifically. `res.writableLength` is an
absolute depth, the socket is a better authority than anything kept beside it, and Node
can observe partial writes — so delta accounting there would genuinely drift.

It is wrong as a *general* rule, and the ABI inherited it as one. Most of the runtimes D3
built the C ABI for cannot answer the question at all:

| runtime | absolute queued depth? |
|---|---|
| Node (`res.writableLength`) | yes |
| ASGI / Uvicorn (`await send()`) | no — suspends, returns nothing |
| Go (`http.ResponseWriter`) | no |
| Swoole | not in this shape |

So §8.2 — half of the loss story this protocol exists for, and the thing that separates it
from hand-rolled SSE — was unimplementable in Python, Go and PHP. An adapter there would
have had to either skip slow-consumer detection entirely or invent its own threshold, and
"invent your own" is precisely what the shared core exists to prevent.

### Decision

**Added `ag_note_sent` and `ag_note_flushed` alongside `ag_note_buffer`.** They feed the
same counter and the same threshold, so the drop decision is identical whichever style a
host uses. `AG_ABI_VERSION` 3000 → **3100** — a *minor* bump, because both are new symbols
returning existing status codes and a 3000-era caller keeps working untouched.

**The drift objection is answered rather than ignored.** It applies to a transport that
reports partial writes, and the hosts that need the delta path do not have one: `await
send()` either completes for the whole frame or the connection is gone. The delta is
always a whole frame, so there is no fractional flush to lose track of. Node keeps the
absolute path and should never move off it. The header says outright not to mix the two
styles on one subscriber.

**Saturating in both directions**, which is the part that matters at 3am. An over-reported
flush must land on zero rather than underflow to `usize::MAX` — that would read as a
subscriber unimaginably far behind and drop one that is entirely caught up. A missed flush
must pin at the top rather than wrap to zero — that reads as a perfectly healthy
subscriber at the exact moment it is furthest behind, which is silent staleness reached
from a new direction.

### A ninth corpus group, 87 → 94 vectors

§8.2's threshold had never been in the corpus at all, despite being a rule two
implementations already had to agree on. `buffer` (7) drives an ops list — `buffer` /
`sent` / `flushed` — against one subscriber and pins the verdict after each.

Verified the way D6 and D9 were, by breaking it first:

- making the comparison inclusive (`>=`) fails **B1** and **B2** — `["ok",
  "slow-consumer", ...]` where `["ok", "ok", ...]` was expected
- making the subtraction wrapping instead of saturating fails **B4**

PROTOCOL.md §8.2 now states the strictness of the comparison, defines "queued bytes" as
written-and-not-drained, and requires an implementation that maintains the count itself to
saturate rather than wrap. Corpus version 0.3.

### Also closed: the header could name a version the library does not speak

`aghoz.h` describes the current ABI revision in prose, and prose drifts. A binding author
reads that number to decide what to refuse to load, so a stale one is worse than none.
`the_header_names_the_current_abi_version` parses `AG_ABI_VERSION` out of the source and
asserts the header says it. Confirmed to fail when the header lags.

---

## D9 — The ABI grows an externally-assigned-id path, and ids are bounded at 2^53 − 1

**Date:** 16 August 2026 · **Status:** accepted

Two changes that had to land together, because both break the C ABI and nothing has
shipped yet. The second was found while writing conformance vectors for the first.

### The hole: no backplane is expressible outside Node

`HubCore` has had `append` and `encode` since the Redis backplane landed. The C ABI had
neither, and `core-native.ts` threw on both with a comment calling it "a gap to close
before a second language binding needs a backplane."

That gap had become load-bearing. D3's own conclusion was that the backplane is a
*prerequisite* for the second binding rather than a feature after it, because Gunicorn,
Puma and Swoole are multi-worker by default. So the ABI supported exactly one deployment
shape — single-process — which is the shape Python, Ruby and PHP never have. A Python
adapter written against ABI 2000 would have shipped the silent partial-delivery failure
the startup warning exists to prevent, and could not have fixed it at the adapter layer.

**Added `ag_append` and `ag_encode`.** Both take the id as its canonical `<ms>-<seq>`
**text**, not as split halves. That is the whole point: `core-native.ts` refused to
implement `encode` over the existing `encodeFrame` precisely because reconstructing an id
in TypeScript would mean parsing one in TypeScript, and §2.1's canonical form is the kind
of rule D3 exists to keep in one place. Parsing now happens in the core on every path.

`ag_encode` takes `&self` in the core, so "records nothing" is compiler-enforced rather
than asserted in a comment.

**`AG_ABI_VERSION` 2000 → 3000.** A major bump because `AG_ERR_MALFORMED_ID` (−15) is a
status a 2000-era caller has no arm for. Free now; a `ag_publish_with_id` shim would have
lived forever.

### The divergence: "unsigned 64-bit" is not implementable

§2 said both halves of an id are unsigned 64-bit. Writing the `idParse` vectors from that
sentence surfaced a real disagreement between the two cores:

| id | TypeScript | Rust (before) |
|---|---|---|
| `9007199254740993-0` | rejected | accepted |
| `18446744073709551615-0` | rejected | accepted |

JavaScript's `Number` is an f64, so `9007199254740992` and `9007199254740993` are the same
value. The TypeScript core rejected everything past `Number.MAX_SAFE_INTEGER`; the Rust
core accepted the full u64 range. **The same cursor string named two different events
depending on which implementation received it** — and the failure would surface as a
client resuming from the wrong place, with nothing erroring.

This is T15's shape exactly: a bound stated in one unit, implemented in whatever unit the
language reaches for first. Every language has its own wrong answer for "length", and its
own wrong answer for "how big is an integer".

**Narrowed §2 to `[0, 2^53 − 1]` rather than adopting BigInt.** BigInt on the id path
costs a boxed allocation per publish and per comparison, on the hottest path in the
library, to buy a range that expires in the year 287396 — and 2^53 − 1 events inside one
millisecond is not a limit anything meets. The spec was wrong, not the implementations.

Verified the way D6 was: the three vectors were run against the unfixed rule first and
observed to fail (P19, P20, P21 — `expected valid=false, got true`), then to pass.

### Two new corpus groups, 57 → 87 vectors

- **`idParse` (21)** — which strings are ids at all. Previously uncovered, despite being
  reachable from the wire in two directions: a client's `Last-Event-ID`, and now a
  backplane-assigned id. This is where the divergence above was caught.
- **`append` (9)** — the externally-assigned-id path, as an ops list applied to a fresh
  hub, pinning both the emitted frames and the cursor afterwards. The cursor is the
  assertion that matters: `append` must advance it so a local fallback cannot reissue a
  spent id, an out-of-order `append` must not rewind it, and `encode` must not touch it.

The corpus gained a `version` field, now `0.2`, so an adapter can report which corpus it
passes. §11's "no version field, a breaking change takes a new mount path" is workable for
one implementation you control and not for adapters you do not.

### What this does not do

The backpressure signal is still `note_buffer(id, absolute_queued_bytes)`, which requires
a host that can report a socket's outstanding depth. ASGI, `net/http` and Swoole cannot;
they backpressure by suspending instead. That is the second ABI hole and it is not closed
here — see the v0.3 roadmap.

---

## D8 — Svelte gets stores, Vue gets a shallow ref

**Date:** 16 August 2026 · **Status:** accepted

`@aghoz/vue` and `@aghoz/svelte` complete v0.2. Both are thin wrappers over
`@aghoz/client` and restate no protocol decision.

### Svelte: stores, not runes

Runes are the current idiom, and stores are the right answer anyway.

`svelte/store` readables are plain JavaScript. One package covers Svelte 4 and Svelte 5,
this repo's build gains no compiler step, and no rune syntax pins the package to a major
version. Svelte 5 still auto-subscribes with `$topic`, so nothing about the rendering code
differs. A runes implementation would have meant a `.svelte.js` module, the Svelte compiler
in the build, and a package that could not serve Svelte 4 at all — in exchange for
identical call sites.

The lifetime comes free, which is the part that actually matters. A readable's start
function runs on the first subscriber and its teardown after the last, so `$topic`
auto-subscription *is* the subscription lifecycle: nothing to clean up, and no leak when a
component is destroyed.

**Consequence, made explicit rather than papered over:** a `topicReducer` restarts from
`initial` when its subscriber count returns to zero and rises again, and it now publishes
that reset rather than only holding it internally. A readable retains its last value across
a stop, so the first version reported the *previous* run's final state until the next event
arrived and then jumped to a fold that had silently dropped it. Restarting is correct — a
fold is only meaningful over an unbroken run of events, and carrying state across a gap in
subscription would be a fold over events it never saw — but the accumulator and what
subscribers see have to start from the same place. Caught by the test that asserted it.

### Vue: `shallowRef`, and a reactive topic

The ref holding a payload is shallow. A deep `ref` would wrap every payload in a reactive
proxy, so an object published is not `===` the object received and any identity check
downstream silently stops working. Payloads arrive whole and are replaced whole; deep
reactivity has nothing to do here but cost. There is a test that pins the identity.

Topics accept `MaybeRefOrGetter`, unlike the React binding's plain string, because that is
the Vue idiom and the subscription is driven by a `watch` whose cleanup both resubscribes on
change and unsubscribes on scope disposal — one mechanism for both, rather than a call plus
a separate `onScopeDispose`.

### Both take an explicit `client`

Every function in both packages accepts one, overriding injection or Svelte context.

Not only for tests, though it is what makes these packages testable in bare Node with no
jsdom and no compiler. Vue's `inject` needs a component or app context and Svelte's
`getContext` throws outside component initialisation, so without the override neither
binding could be used from a plain module — a store defined at module scope, a composable
called from a router guard. Svelte's failure is also opaque (`lifecycle_outside_component`),
so `getAghozClient` catches it and reports the two fixes by name.

---

## D7 — The Nest adapter provides a hub, not a route

**Date:** 16 August 2026 · **Status:** accepted

`@aghoz/nest` ships `AghozModule.forRoot`/`forRootAsync`, an `AGHOZ_HUB` token and
`createAghozHandler`. It does **not** register a controller, and it works on both the
Express and Fastify platforms.

### Why no controller

Auto-mounting is what a Nest integration is normally expected to do, and it is wrong here.
A route this package registered would carry none of the application's `@UseGuards()`, and
guards are where a Nest application's authentication lives. The premise of the whole
library is that the host's authentication runs *before* the hub sees a request — so the
convenience feature would quietly produce the one route in the app that bypassed it.

This is the same line D5 drew in refusing a metrics endpoint, and it is worth being
consistent about: this library does not mount routes, because it cannot know what is
supposed to guard them.

The cost is a ten-line controller in the README. The alternative was a class generated
inside `forRoot` — which also cannot accept the user's guards, since decorators are applied
at class-definition time, before `forRoot` is ever called.

### Why `@Sse()` is unusable

Predicted on the roadmap and confirmed. `@Sse()` takes an Observable and writes the
response itself: it owns the status, the headers and the framing, and exposes no way to add
one. `last-event-id-checkpoint` (§4.4) is therefore unreachable, so a client can never be
told it missed events — which is the only thing this library does that polling does not.
The adapter uses `@Res()`, putting Nest in library-specific mode.

Exactly the reason `@aghoz/client` does not use `EventSource`: an abstraction that owns the
response owns what can be said in it.

### `beforeApplicationShutdown`, not `onApplicationShutdown`

Found by the test suite hanging after every assertion passed. Nest tears down in this
order: `onModuleDestroy` → `beforeApplicationShutdown` → **close the HTTP server** →
`onApplicationShutdown`.

`server.close()` waits for open connections to end, and an SSE stream never ends on its own
— that is what it is for. A hub still holding subscribers when the server closes means
`app.close()` never resolves, and closing at `onApplicationShutdown` is too late to help
because nothing reaches it. Dropping subscribers one step earlier lets the server find
itself idle.

Worth recording because the wrong hook is the obvious choice, the symptom appears nowhere
near the cause, and it is invisible to anyone who never opens a stream before shutting down.

---

## D6 — Truncation is decided against the newest evicted id, not the oldest retained one

**Date:** 16 August 2026 · **Status:** accepted · **Amends:** PROTOCOL.md §4.4, §8.1

Both cores computed `truncated = cursor < oldest_retained_event`. That is wrong in both
directions, and the metrics work in D5 is what surfaced it — `truncated` was the number
the README had just finished calling the one worth alerting on.

### The false positive

`0-0` is the cursor §5 hands out before anything has been published, and the quickstart
tells you to pass it to the page alongside its initial data. It sorts below every real id,
so on a freshly booted hub the first stream connect compared as `earliest` — replaying
everything correctly *and* reporting a gap the client could not possibly have had:

```
cold cursor      : 0-0
history length   : 2 (nothing was ever trimmed)
frames replayed  : 2
truncated        : true
```

Every first page load after a deploy refetched, and a signal that fires when nothing is
wrong is a signal people learn to ignore.

### The false negative, which is worse

An event larger than the entire history budget is evicted by the push that stored it,
leaving the ring **empty**. With no oldest retained entry there was nothing to compare
against, so the guard `oldest !== undefined` short-circuited and a real loss was reported
as "nothing missed". That is silent staleness — the single failure mode §0 says this
protocol exists to eliminate — reachable from one oversized publish.

### Decision

Track the **highest id ever evicted** and compare against that:

```
truncated = last_trimmed !== null && cursor < last_trimmed
```

A cursor *equal to* the evicted id is not a gap: that is the event the client already
holds, and everything after it is still retained. Never having evicted anything means no
cursor can have missed anything, including `0-0`.

Held as a maximum rather than "the last one popped", so an out-of-order `append` — a
backplane replaying into the ring — can only push the mark forward. Over-reporting is a
false alarm; under-reporting is data loss with no symptom, and the two are not equally bad.

### Why this got a corpus category rather than two matching patches

`checkpoint` is the sixth group in `conformance/vectors.json` (7 vectors, 50 → 57). The
bug existed identically in TypeScript and Rust, which is exactly the failure the corpus is
supposed to make impossible — and it had gone unnoticed because the corpus covered
encoding, validation and id order, but never the decision those exist to serve.

Fixing it in two places without a vector would have left the next implementation free to
reintroduce it. All three runners now execute the same seven vectors: the TypeScript core,
the Rust core directly, and the Rust core through its Node binding. Confirmed to fail on
the unfixed code first — CP1, CP4 and CP7, identically in both languages.

No ABI change: the binding already reported the checkpoint as `"absent"`/`"echo"`/
`"earliest"`, so the corpus asks it the same question it already answered.

---

## D5 — Counters live in the handler layer, and are counters rather than rates

**Date:** 16 August 2026 · **Status:** accepted

`hub.stats()` is implemented entirely in `packages/server/src/stats.ts` and wired from
`create-hub.ts`. Nothing was added to `hub.ts`, to `HubCore`, or to the C ABI.

### Why not the core

D3 put one Rust core behind a stable C ABI precisely so protocol rules could not diverge
between languages, and `conformance/vectors.json` is what enforces it. A counter is not a
protocol rule. Putting one in the core would have meant a third ABI break, a new corpus
category and a matching implementation in every future binding — for a number no wire
format depends on and no other implementation has to agree about. `hub.ts` already says
"do not add behaviour here that the corpus does not pin down", and this is the first real
test of that line.

The placement also happens to be where the interesting failures are. Every close reason
worth distinguishing — a client abort, a §8.2 drop, a §4.6 revocation, an eviction, a
shutdown — is a socket-layer event the core never sees.

**The cost, accepted:** ring occupancy — how full `maxHistoryBytes` is — is core state the
ABI does not expose, so it is not reported. `truncated` covers the consequence, which is
the part anyone would alert on; the cause can be added when the ABI grows a reason to
change anyway. Buying it now would mean breaking the ABI for a gauge.

### Why totals and not rates

The roadmap item said "publish rate". What shipped is `published` plus `uptimeMs`.

Any window this library averaged over would be the wrong one for someone, and it is not
reversible from the outside: a consumer handed a smoothed rate cannot recover the counter,
while a consumer handed a counter can compute any rate it likes. Prometheus, StatsD and
OpenTelemetry all expect counters and derive rates themselves, so emitting a rate would
mean every one of them undoing work this library did not need to do.

### Why closes are attributed rather than totalled

`closed` is a map by cause, not a number, and `rejected` likewise. A total that is right
but filed under the wrong reason is worse than no metric at all — it sends whoever reads
it after the wrong problem with full confidence.

Making that trustworthy shaped the code: `drop()` takes its reason from the caller and is
idempotent, deleting from the connection map *before* `res.end()`. Without that ordering
the `close` event a deliberate drop causes would land a second later and record `client`,
and every eviction, revocation and slow-consumer drop would be invisible under a
plausible-looking client-churn number. `packages/server/test/stats.test.mjs` pins it.

Rejections are bucketed by a `status → reason` mapping in one place rather than at each
call site, for the same reason: the two travelling separately is how a bucket ends up
mislabelled. Its default arm is `bad-request`, so a status added later is counted as
something rather than vanishing from the totals.

### Not shipped: a metrics endpoint

`cursorHandler()` exists, so a `metricsHandler()` would have been the consistent move. It
was rejected. The premise of this library is that the host application's authentication
runs before the hub sees a request; a route the library mounts itself would be the one
thing in it that bypassed that, and connection counts and rejection reasons are a
description of the host's traffic. The README shows the three-line mount instead.

---

## D4 — Name: aghoz, final

**Date:** 15 August 2026 · **Status:** accepted · **Supersedes:** D0

D0 deferred the name and made `pushmount` the working default, on the grounds that the
open question — *does "push" read as the Web Push API?* — would be answered by evidence
rather than by argument. It named two triggers to revisit: a real user reporting the
confusion, or the moment before claiming the npm organisation, which is the first
irreversible step.

The second trigger arrived, together with a clearer statement of what the name is for: a
brand, not a description.

### Decision

**`aghoz`** — from the Filipino *agos*, "flow" or "current".

Clear on npm, crates.io and GitHub. Notably it is the *only* spelling in that family that
is: `agos` itself is taken on both npm and the GitHub organisation, and `agoz`, `aghos`
and `agosa` all have the organisation taken. The available name and the wanted name
happened to coincide, which is not the usual outcome of a naming round.

### What was rejected, and why it is worth writing down

**`heartbeat`** — taken on npm, crates.io and GitHub, and colliding with two established
infrastructure tools (Elastic's Heartbeat, the Linux-HA daemon). The disqualifying problem
is closer to home though: "heartbeat" is the industry term for the SSE keepalive comment
that holds a connection open, which this project *sends* — §6.2, `:ka` frames, the
`keepAliveMs` option. A product cannot be named after one of its own internal mechanisms
without losing the ability to talk about either.

**`pushmount`** — the incumbent, and a genuinely good description: "mount" names the
differentiator against Mercure and Centrifugo in one word. But a description is not a
brand, and "push" in a JavaScript package continues to read as the Web Push API. Its own
D0 flaw was never resolved, only deferred.

### The cost, and why it was paid now rather than later

§0 keeps the name off the wire and a conformance test enforces it, so the rename was a
find-and-replace across manifests, imports and prose — no compatibility consequence, and
the invariant now asserts that "aghoz" is absent from every wire literal, which is the
proof the rename stayed a rename.

The one part that was *not* free is the C ABI, where every symbol carried a `pm_` prefix.
Renaming those to `ag_` is an ABI break. It cost nothing today only because `pm_publish`
had just gained its §6.0 `origin` parameter and `PM_ABI_VERSION` had already been bumped
1000 → 2000 in the same session — so one break absorbed both changes. A month from now,
with a Python or Go binding built against it, that would have been a second break and a
second version. Deciding the name before the first binding ships was worth more than
deciding it well.

### The organisation is claimed

`@aghoz` was created on npm on 15 August 2026, which closes the question D0 and D0-history
both left open — the unscoped name had been confirmed free, but npmjs.com returns 403 on
unauthenticated organisation lookups, so the *scope* could never be verified from outside.
It was the last blocker on publishing anything at all, whatever the name turned out to be.

### Known weakness, accepted

`aghoz` cannot be spelled from hearing it: "gh" in English is /g/ in *ghost*, /f/ in
*rough*, and silent in *through*. A developer who hears the name in a talk cannot reliably
find it. This is survivable for a library discovered by search and by reading rather than
by ear, on the condition that the README states the pronunciation and the origin in its
first screen. That is a documentation obligation, not an afterthought.

---

## D3 — One Rust core, in-process bindings per language

**Date:** 13 August 2026 · **Status:** accepted · **Supersedes:** D2

### Why D2 is reversed

D2 was decided correctly against the wrong premise. It asked "does the *Node* hub need
Rust?" and answered no, on measurements that still stand. The actual goal is broader:
**the same in-process hub in Python, Go and Ruby, not only Node.**

That changes what the cost buys. D2 priced a ~2x slowdown on Node's hot path against
avoiding *one* extra implementation, and correctly called that a bad trade. Against
avoiding *five* hand-written hubs — each with its own version of the id rules, the
injection defence and the checkpoint atomicity — it is a good one. 37k publishes/sec
with 37x headroom is affordable in any of them.

The conformance corpus also scales worse than assumed. It works well across two
implementations. Across five it becomes the only thing standing between the project and
five subtly different definitions of "newer than the cursor" — and vector T15 is the
proof that this class of bug recurs independently per language, because every language
has its own wrong answer for "length".

### Decision

1. **`core/` is a Rust crate** owning everything the corpus pins: ids, topic validation,
   frame encoding, the history ring, the subscriber registry, checkpoint-and-replay, and
   backpressure decisions. No IO.
2. **A stable C ABI** is the single surface every language binds to, with idiomatic
   wrappers above it (napi for Node, PyO3, cgo, magnus). This is the SQLite/libgit2
   shape and it exists because the ABI is the expensive thing to change, not the core.
3. **HTTP stays per-language.** Sockets, headers and framework integration are not
   portable and should not be forced through FFI. Only the protocol is shared.
4. **The existing 93 Node tests are the acceptance suite for the core.** Swapping the
   TypeScript hub internals for the Rust core must leave every one of them passing,
   unchanged. That is a far stronger completeness check than new Rust tests written in
   isolation would be.

### The consequence that reorders the roadmap

**The backplane stops being a v0.3 feature and becomes a prerequisite for the second
binding.**

Node applications are commonly single-process. Gunicorn and Puma are multi-*worker* by
default — that is the recommended configuration, not an edge case. An in-process hub in
a Django app under four workers delivers each publish to a quarter of its subscribers,
silently. The startup warning added in P5 would fire on a normal deployment rather than
an unusual one, which makes it noise instead of a signal.

So: Redis backplane before Python or Ruby ships, not after.

**PHP is out.** PHP-FPM's request-per-process model cannot hold a long-lived connection
at all. Say so in the README rather than leaving people to discover it.

---

## D2 — The Node hub is TypeScript. Rust is for the standalone hub.

**Date:** 13 August 2026 · **Status:** **superseded by D3** — the measurements below
remain valid; the premise they were applied to did not · **Evidence:**
`spikes/wasm-vs-ts/`

### What was claimed

The build plan argued that a Rust core compiled to wasm should back
`@pushmount/server`, on two grounds: that a hand-written TypeScript hub would drift from
the Rust one, and that wasm avoids the prebuild matrix and `.node` bundler problems that
a native addon brings.

Both grounds were assertions. P0 exists to measure them.

### What was measured

A minimal hub — id assignment with the §2.2 monotonicity rule, §3 topic validation,
§6.1 frame encoding with payload segmentation, a byte-bounded history ring, and
subscriber matching — was written twice: once in Rust compiled to wasm, once in plain
JavaScript. An equivalence gate asserts byte-identical frames on every conformance vector
before any timing runs.

Apple Silicon, Node 22.22.2, `wasm-pack --release` with `lto = true`:

| scenario | wasm ops/s | JS ops/s | ratio |
|---|---|---|---|
| 200 B payload, 0 subscribers | 348k | 253k | **1.38x** |
| 200 B payload, 100 subscribers | 233k | 201k | **1.16x** |
| 200 B payload, 1000 subscribers | 37k | 45k | **0.83x** |
| 2 KB payload, 100 subscribers | 48k | 74k | **0.65x** |

Isolating the boundary from the logic, at 200 B and 100 subscribers:

```
rust logic only, no boundary crossing    434k ops/s
wasm as called from node                 233k ops/s   ← 46% lost to marshalling
plain javascript                         201k ops/s
```

### What that means

**The Rust logic is genuinely 2.2x the JavaScript.** That part of the claim held. But
marshalling costs 46% of it, and the cost scales with payload size — strings are copied
into linear memory on the way in and the frame is copied out on the way back, once per
publish. At the payload sizes real applications send, **wasm is slower than plain
JavaScript**, by up to 35%.

Zero-copy reads of the frame out of linear memory would recover part of this. They would
not change the decision: the ceiling is 434k and JS already delivers 201k, against a busy
single-process application publishing on the order of 1k/sec. Both implementations have
two orders of magnitude of headroom. **The Node path has no performance argument for
Rust, in either direction.**

**The divergence argument was also weaker than claimed.** The spike's TypeScript hub is
byte-identical to the Rust one on every vector, and the equivalence gate proves it on
every run — it failed loudly during development when the two disagreed. A second
implementation is not inherently unsafe when a conformance corpus is the arbiter. That
was the main argument for wasm and the measurement did not support it.

### Decision

1. **`@pushmount/server` v0.1 is pure TypeScript.** No wasm, no napi, no prebuild
   matrix, no `.node` files, no `optionalDependencies`, zero runtime dependencies. This
   is the strongest possible position for the ten-minute definition of done, which is the
   metric the product is actually judged on.
2. **The Rust core is built in v0.3, for the standalone hub**, where there is no
   JavaScript, no boundary, and the 2.2x is uncontested — and where the backplane owns id
   assignment, which is the part that genuinely benefits from one careful implementation.
3. **`PROTOCOL.md` §12 is the contract between them.** The corpus is generated once and
   both implementations are tested against it in CI. `spikes/wasm-vs-ts/bench.mjs` is the
   prototype of that gate.

### The cost of this decision, stated plainly

From v0.3 there are two hub implementations to keep in step, forever. The spike covered
roughly the easy fifth of the surface — it does not include replay ordering, backpressure
accounting, gap conditions, connection caps, or backplane sequencing. The corpus mitigates
drift but does not eliminate the work.

**Evidence from both directions, added after the corpus was built.** Vector T15 found a
real divergence on its first run: §3 bounds a topic at 255 **bytes**, but the JavaScript
hub measured `topic.length`, which counts UTF-16 code units. An 86-character Japanese
topic is 258 UTF-8 bytes — rejected by Rust, accepted by JavaScript, and a validation
bypass on the field whose validation exists to prevent frame forgery.

Read pessimistically, that is the two-implementation risk made concrete, and it appeared
in the *easy* fifth of the surface. Read optimistically, the corpus caught it in under a
second, on the first run, before any of it shipped — which is precisely the guarantee this
decision rests on. Both readings are fair. What the episode does settle is that the
guarantee is only as good as the corpus, so under D2 the corpus is not a deliverable that
can be deferred.

The alternative — accepting a measured ~2x slowdown against plain JavaScript, plus a wasm
artifact in the npm package, to avoid that maintenance — is a legitimate choice. It is
just not the one the numbers favour.

### Alternative not measured

napi-rs marshals more cheaply than `wasm-bindgen` and would land somewhere between the
two columns. It was not benchmarked because it reintroduces exactly what the definition of
done can least afford: a six-platform prebuild matrix, a Rust toolchain fallback, and the
`.node` webpack-alias failure that has bitten this author before. If D2 is reversed in
favour of a native binding, benchmark napi first.

---

## D1 — `Last-Event-ID` is settable from `fetch`; the header path is primary.

**Date:** 13 August 2026 · **Status:** accepted for Chromium, open elsewhere ·
**Evidence:** `spikes/last-event-id/`

`PROTOCOL.md` §4.1 accepts a cursor from either the `Last-Event-ID` request header or a
`last_event_id` query parameter. The query parameter exists only in case the header is a
forbidden header name under the Fetch spec, in which case the browser drops it *silently* —
shipping a client that appears to reconnect with a cursor while actually reconnecting
without one, which is precisely the invisible loss the product claims to eliminate.

An echo server plus a browser page settles it by observation rather than by reading the
spec.

| engine | result |
|---|---|
| Chromium 151 (HeadlessChrome) | **PASS** — header arrives, canonical and lowercase; query fallback also works |
| Firefox | not run — not installed on this machine |
| Safari | not run — `safaridriver --enable` requires user authorisation |

`Last-Event-ID` does not appear in the Fetch spec's forbidden-request-header list, which
is consistent with the Chromium result and makes divergence unlikely. **Unlikely is not
verified.** Run `node spikes/last-event-id/server.mjs` and open `http://localhost:8787`
in Safari and Firefox before the client ships; the page states its own verdict.

**Decision:** header is the primary path. The query parameter stays in the protocol as a
fallback and is exercised by tests regardless, because it costs nothing and it is the
escape hatch if a future engine disagrees.

---

## D0 — Name: pushmount, held provisionally

**Date:** 13 August 2026 · **Status:** **superseded by D4** — the deferral did its job;
the name was settled on evidence rather than on the speculation this entry declined to
make. Kept unedited, because a decision log that rewrites what it once concluded is worth
nothing.

Five rounds of candidates did not converge, because they genuinely are close: each one
trades a real flaw for a different real flaw. Continuing to deliberate was costing more
than the gap between the finalists.

| candidate | availability | the flaw |
|---|---|---|
| **pushmount** *(incumbent)* | npm, crates, org, `.dev`, `.com` | "push" in a JS package reads as the Web Push API |
| pubward | all clear, zero prior art anywhere | `-ward` means *toward*, inverting the one-way direction; "pub" reads as a bar |
| tailfeed | all clear | "feed" leans RSS |
| subflare | all clear except `.com` | "-flare" reads Cloudflare-adjacent in exactly this space |
| eventfold | crates.io taken | "event" collides with event sourcing and `EventSource` |
| praeco | org and `.dev` taken | an existing 577-star Elasticsearch alerting tool |
| spargos | org taken | not a Latin form; the correct `spargo` is taken on npm |

### Why deferring is the right call rather than a dodge

The open question — *does "push" make people think this is the Web Push API?* — has a
real answer, and we do not have it. It arrives as the first confused issue, or as the
absence of one. Deciding now means deciding on speculation; deciding later means
deciding on evidence.

Deferring is only available because §0 keeps the name off the wire. It appears in package
manifests, imports and prose, and nowhere else. Renaming stays a find-and-replace with no
compatibility consequence, **including after v0.1 ships**. A conformance test enforces
that property, so it cannot quietly decay.

When candidates are this close, the incumbent wins by costing nothing: `pushmount` is
already in the repository with the suite green.

### Revisit when

- a real user reports confusion with Web Push, or with Pusher/Pushpin/Pushover; or
- we are about to claim the npm organisation, which is the first irreversible step.

**Still unverified:** the `@pushmount` npm *scope*. npmjs.com returns 403 on
unauthenticated org lookups, so only the unscoped name was confirmed free. This is the
one blocker on publishing, whatever name wins.

---

## D0-history — the naming rule that made deferral possible

**Date:** 13 August 2026 · **Status:** accepted

Chosen from a checked shortlist. Clear on npm (unscoped), crates.io, GitHub org,
`pushmount.dev` and `pushmount.com`. Rejected: `downwire` (working name), `hudyat` /
`sigaw` (Filipino; user asked for English), `tailfeed` (clear, `tail -f` metaphor),
`newswire` and `tailwire` (org or domain taken).

"Mount" names the differentiator — the hub is a route inside the host application, not a
service you deploy — which is the positioning against Pusher, Mercure and Centrifugo in
one word.

**Open:** the `@pushmount` npm **scope** is unverified. npmjs.com returns 403 on
unauthenticated org lookups, so only the unscoped name was confirmed free. Confirm by
creating the org before P5.

**Standing rule:** the product name never appears on the wire (`PROTOCOL.md` §0). This is
why the SSR cursor stamp is `event-cursor` and not `pushmount-cursor`. A conformance test
enforces it.
