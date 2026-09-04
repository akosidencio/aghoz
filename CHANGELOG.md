# Changelog

All packages ship in lockstep — the conformance guarantee only holds if the packages
sharing the corpus share a version. Reasoning for anything significant lives in
[DECISIONS.md](./DECISIONS.md).

## 0.4.3 — 2026-09-04

### Added

- `Client.onCutover` / `SharedClient.onCutover` — the topics whose stream reopened
  without a baseline, reported after it is open (PROTOCOL.md §9.3, D19).
- `Client.onHandlerError` — a handler that threw or rejected, with its topic and id,
  after the cursor had already advanced past it (§9.2, D21).
- `onCutover` and `onHandlerError` options on `@aghoz/react`, `@aghoz/vue`,
  `@aghoz/svelte`.
- `@aghoz/redis`: `scope`, one sequence and retention budget per tenant (§2.4, D22).
- PROTOCOL.md §2.4 — feed scopes; a cursor names one sequence, cursor vectors rejected.
- `conformance/client/` — the subscriber corpus, 14 vectors. `pnpm conformance:client`.
- `docs/OUTBOX.md` and `examples/outbox-sqlite/` — the publication boundary (D20).
- Rust: `cargo clippy`, `cargo fmt` and `cargo deny` gated in CI (D18).

### Changed

- `@aghoz/react-query` invalidates on a cutover, and on a failed parse or updater in
  `useTopicQueryData` (which then re-throws, so the failure is still reported).
- `@aghoz/redis` warns when two backplanes in one process share a stream key.
- Every C ABI entry point taking a pointer is now `unsafe extern "C" fn` (D18). No
  symbol, signature or `aghoz.h` declaration changed.

### Fixed

- §2's 2^53 − 1 id bound is enforced on the numeric paths, not only on the string one —
  a host reporting nanoseconds could drive the cursor backwards (D18).
- Subscriber ids no longer truncate to `u32` crossing into Node (D18).
- `~denied` frames could be made unparseable by a topic containing a raw LF (D18).

### Breaking changes

`AghozClient` gained two members. Implementing that interface yourself is a compile
error until you add them; using the shipped clients is unaffected.

Rust callers must construct `EventId` with `EventId::new` and read it through `ms()` and
`seq()`, handle `PublishError::IdOutOfRange`, and call pointer-taking `aghoz-abi` exports
inside `unsafe`. The C symbols and C header declarations are unchanged, and the crates are
not published, so this lands as a patch: nothing installed from npm changes shape.

## 0.4.2 — 2026-08-18

- Backplanes are closed with the hub rather than left holding a connection.
- CI fixes.

## 0.4.1 — 2026-08-18

- Bun production canary: the HTTP corpus, the Nest Express path and Redis Streams run
  on Bun 1.3.14 in CI.

## 0.4.0 — 2026-08-16

- First tagged release. Roadmap v0.1–v0.4 complete: hub, client, React/Vue/Svelte and
  TanStack Query adapters, Express/Fastify/Nest mounts, the Redis Streams backplane,
  the Rust core and C ABI, both hub corpora, multi-tab sharing and persistent history.
- A restarted hub had been answering "you missed nothing" to every resuming client
  since v0.1; a cursor newer than any id the hub has issued is now a gap (D12).
