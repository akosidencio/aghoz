/**
 * @aghoz/redis — a backplane on Redis Streams.
 *
 * Streams are the right primitive rather than pub/sub, for one reason that decides
 * everything else: **`XADD` assigns exactly the `<ms>-<seq>` id this protocol uses**.
 * §2 fixed that format so a shared sequencer could issue it, and Redis is that
 * sequencer — no per-process counter, no collision between pods, no client silently
 * discarding a real event as already-seen.
 *
 * The stream is also the shared history, so `XRANGE key (cursor +` is the replay a
 * client needs after reconnecting to a different process. Pub/sub would give fan-out
 * and nothing else: no ids, no history, no way to answer "did I miss anything".
 *
 * The Redis client is injected rather than imported, so this package has no third-party
 * runtime dependency and works with ioredis, node-redis, or anything presenting the
 * same handful of commands.
 */

import type { Backplane, BackplaneEvent, BackplaneReplay } from '@aghoz/server'

/** The commands this backplane needs. Both ioredis and node-redis satisfy it. */
export interface RedisLike {
  xadd(...args: (string | number)[]): Promise<string | null>
  xrange(key: string, start: string, end: string, ...rest: (string | number)[]): Promise<StreamEntry[]>
  xrevrange(key: string, start: string, end: string, ...rest: (string | number)[]): Promise<StreamEntry[]>
  xread(...args: (string | number)[]): Promise<StreamReadReply | null>
  /**
   * Optional, and only used for the history floor marker — see `replay`.
   *
   * Optional because the marker is what makes the loss answer *accurate*, not what makes
   * it *safe*: an adapter that omits these degrades to answering "you may have missed
   * something" in the two cases the marker exists to resolve, which is the direction a
   * wrong answer has to err in. Every adapter that can implement them should.
   */
  get?(key: string): Promise<string | null>
  setnx?(key: string, value: string): Promise<number>
  quit?(): Promise<unknown>
  disconnect?(): void
}

/** `[id, [field, value, field, value, ...]]` */
export type StreamEntry = [string, string[]]
/** `[[streamKey, entries], ...]` */
export type StreamReadReply = [string, StreamEntry[]][]

export interface RedisBackplaneOptions {
  /** Used for XADD, XRANGE and XREVRANGE. */
  redis: RedisLike
  /**
   * A **second** connection, used only for the blocking read.
   *
   * `XREAD BLOCK` monopolises its connection for the duration of the block, so sharing
   * one client would stall every publish behind the reader. This is the single most
   * common way a Redis Streams integration is got wrong.
   */
  subscriber: RedisLike
  /**
   * Stream key. Default `aghoz:events`.
   *
   * A second, tiny key — `<key>:floor` — sits beside it and records what the stream can
   * vouch for; see `replay`. It is written at most once per stream and never expires.
   * Delete the two together: a floor left behind by a deleted stream describes history
   * that no longer exists, which costs a false gap rather than a missed one, but a stream
   * rebuilt under a name whose floor was deleted has nothing to vouch with.
   *
   * Mutually exclusive with `scope`, which is the same setting with a name that says
   * what choosing it means.
   */
  key?: string
  /**
   * PROTOCOL.md §2.4 — the feed scope this backplane serves.
   *
   * The stream key becomes `aghoz:<scope>:events`, and that is the entire mechanism:
   * **one scope is one sequence**, with its own ids, its own `maxLen` retention budget
   * and its own replay scan. Partitioning happens here, by running a hub per scope, and
   * not inside a cursor — §2.4 says why a cursor vector was rejected.
   *
   * Reach for it when one stream is doing work for tenants that have nothing to do with
   * each other. The default single key is one retention budget shared by everybody, so
   * the loudest tenant decides how far back the quietest one can resume from, and every
   * reconnect scans a log that is mostly other people's events.
   *
   * The cost is that a cursor is only meaningful inside its own scope. Nothing on the
   * wire distinguishes one scope's ids from another's, so a cursor carried across
   * scopes is silently interpreted against the wrong sequence — mount each scope on its
   * own path, and stamp §5's `event-cursor` from the hub that owns it.
   */
  scope?: string
  /**
   * Approximate cap on retained events — the shared equivalent of `maxHistoryBytes`.
   *
   * Redis trims by entry count, not bytes, so this is a count. `~` is used so Redis may
   * trim at a node boundary, which is dramatically cheaper and is why the cap is
   * approximate.
   */
  maxLen?: number
  /** How long a blocking read waits before looping, in ms. Default 5000. */
  blockMs?: number
  /**
   * The most entries one reconnect may scan out of shared history. Default 1000.
   *
   * The cursor is supplied by the client, so without a bound a single request saying
   * `last_event_id=0-0` reads the entire retained stream — `maxLen` entries by default
   * — re-encodes every one of them and writes the lot to one socket. That is a request
   * amplification anyone can aim at the hub, and it costs the same whether it is
   * malicious or a laptop that was closed for a week.
   *
   * Past the cap the answer is a gap, not a partial replay. Serving the first N and
   * stopping would leave a hole between them and live events while the client's cursor
   * advanced past it — the client would believe it had caught up, which is exactly the
   * silent loss §8 exists to make impossible. A gap tells it to refetch instead.
   */
  maxReplay?: number
  onError?: (error: unknown) => void
}

const FIELD_TOPIC = 't'
const FIELD_PAYLOAD = 'p'
/** §6.0. Absent rather than empty when there is no origin, so old entries still read. */
const FIELD_ORIGIN = 'o'

/**
 * What the `<key>:floor` marker records: the oldest id the stream is known to have held,
 * and whether that id is the stream's own beginning or merely where this deployment
 * started watching.
 *
 * `created` is the load-bearing bit. Only a process that saw the stream empty and then
 * wrote its first entry can claim it, and only that claim licenses the answer "nothing
 * has ever been evicted from here" — which is the answer §4.4 demands for a `0-0` cursor
 * on a stream that has never trimmed. `adopted` says the opposite: entries may have gone
 * before anyone here was looking, so no cursor below the retained range can be vouched
 * for.
 */
const FLOOR_CREATED = 'created'
const FLOOR_ADOPTED = 'adopted'

interface Floor {
  /** True when the recorded id is the stream's first entry, not just the oldest seen. */
  readonly created: boolean
  readonly id: string
}

/**
 * §2.4 — which scope names are usable as a key segment.
 *
 * Printable ASCII without spaces, and without the glob metacharacters `* ? [ ]`: an
 * operator finds these keys with `SCAN MATCH aghoz:*`, and a scope carrying a `*` makes
 * one tenant's pattern match another's stream. 128 bytes is well past any tenant id and
 * short enough that the key stays readable in `redis-cli`.
 */
function assertScope(scope: string): void {
  const bytes = new TextEncoder().encode(scope).length
  if (bytes === 0 || bytes > 128) {
    throw new TypeError(`aghoz: scope must be 1-128 bytes, got ${bytes}`)
  }
  for (const char of scope) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code >= 0x7f || '*?[]'.includes(char)) {
      throw new TypeError(`aghoz: scope contains an unusable character: ${JSON.stringify(char)}`)
    }
  }
}

/**
 * Stream keys this process already has a backplane on.
 *
 * Two backplanes on one key inside one process is a copy-paste, and a quiet one: both
 * hubs read every event on the stream, so each one fans out the other's topics to its
 * own subscribers. Authorization still holds — every subscriber asked for its topics —
 * but a scope that exists to keep tenants apart has stopped doing it, and nothing errors.
 */
const keysInUse = new Map<string, number>()

export async function createRedisBackplane(
  options: RedisBackplaneOptions,
): Promise<Backplane> {
  const { redis, subscriber } = options
  if (options.key !== undefined && options.scope !== undefined) {
    throw new TypeError('aghoz: pass either key or scope, not both — they name the same thing')
  }
  if (options.scope !== undefined) assertScope(options.scope)
  const key =
    options.key ?? (options.scope === undefined ? 'aghoz:events' : `aghoz:${options.scope}:events`)
  const floorKey = `${key}:floor`

  const maxLen = options.maxLen ?? 10_000
  const blockMs = options.blockMs ?? 5_000
  const maxReplay = options.maxReplay ?? 1_000
  const onError = options.onError ?? (() => {})

  let sink: ((event: BackplaneEvent) => void) | undefined
  let running = true

  // Start reading from whatever exists now, not from '$'. With '$' the reader would
  // begin at the *next* event, so anything published between this call and the first
  // XREAD would never be delivered to this process.
  let lastRead = await newestId(redis, key)

  // Whether this process found the stream empty. Only such a process can ever write a
  // `created` floor, because only it can know that the entry it adds is the first one.
  const startedEmpty = lastRead === '0-0'
  let floorWritten = false

  /**
   * Records the floor if nothing has recorded one yet. At most one write ever wins:
   * SETNX makes the earliest observer the one whose account of the stream's beginning
   * stands, so a later process starting mid-life cannot downgrade a `created` floor.
   *
   * `firstPublished` is the id this process just added, supplied only from `publish`.
   * The claim is checked rather than assumed: it counts as the stream's beginning only
   * if it is *also* the oldest entry, so a publish that raced in behind another process
   * records `adopted` and the answer stays conservative.
   */
  async function writeFloor(firstPublished?: string): Promise<void> {
    if (floorWritten || redis.get === undefined || redis.setnx === undefined) return
    // `== null` rather than `=== null`: a missing key is `null` in ioredis and node-redis,
    // but the client here is whatever was injected, and reading `undefined` as "a floor
    // exists" would quietly leave the stream with none at all.
    const existing = await redis.get(floorKey)
    if (existing != null) {
      floorWritten = true
      return
    }
    const oldest = await oldestId(redis, key)
    // An empty stream has no beginning to record yet. The next publish will have one.
    if (oldest === undefined) return
    const created = startedEmpty && oldest === firstPublished
    await redis.setnx(floorKey, `${created ? FLOOR_CREATED : FLOOR_ADOPTED}:${oldest}`)
    floorWritten = true
  }

  async function readFloor(): Promise<Floor | undefined> {
    if (redis.get === undefined) return undefined
    const raw = await redis.get(floorKey)
    if (raw == null) return undefined
    const sep = raw.indexOf(':')
    if (sep === -1) return undefined
    return { created: raw.slice(0, sep) === FLOOR_CREATED, id: raw.slice(sep + 1) }
  }

  /**
   * §4.4 — "has an event *newer than this cursor* been evicted?"
   *
   * That is not the question "is this cursor older than the oldest entry the stream still
   * holds", and answering the second one is wrong in both directions:
   *
   * - A stream that has never trimmed still has an oldest entry, and every cursor below
   *   it — including the `0-0` §5 hands out before the first publish — compares as a gap
   *   despite nothing having been dropped. That is a `~gap` on every cold page load, and
   *   it arrives *alongside* the complete replay that disproves it.
   * - A stream that has been deleted, expired, evicted whole by `maxmemory`, or lost to a
   *   failover onto a replica that never received the writes has no oldest entry at all.
   *   With nothing to compare against, total loss compares as "you missed nothing" —
   *   silent staleness, which is the one failure §0 exists to eliminate.
   *
   * Redis trims implicitly on `XADD`, so the newest evicted id is not observable and no
   * amount of reading the stream recovers it. What is recoverable is whether anything was
   * evicted *at all*, which needs one durable fact the stream itself does not carry: the
   * id it began with. That is the `<key>:floor` marker, and everything below reduces to
   * it. Where the exact watermark would still be needed — a cursor sitting precisely on
   * the last evicted id, which §4.4 says to echo — this reports a gap instead. That is a
   * one-entry-wide false alarm costing a refetch, and it is the direction to be wrong in.
   */
  async function missedAnything(cursor: string): Promise<boolean> {
    const [newest, oldest, floor] = await Promise.all([
      newestId(redis, key),
      oldestId(redis, key),
      readFloor(),
    ])

    // Above every id the stream holds. Every cursor is an id `XADD` issued on this
    // stream, so a cursor the stream cannot reach means it is no longer the stream that
    // issued it — deleted and rebuilt, or failed over onto a replica missing the writes.
    // Whatever it holds now, it is not what this client is asking about.
    if (compareIds(cursor, newest) > 0) return true

    // Inside the retained range: nothing at or after the cursor can have been evicted,
    // because Redis evicts from the front. Equal is not a gap — that entry is the one the
    // client already holds.
    if (oldest !== undefined && compareIds(cursor, oldest) >= 0) return false

    // The stream holds nothing at all. A floor means it did hold entries once and no
    // longer does, so even a cold-start cursor has lost events it would otherwise have
    // been served. No floor means nothing here ever wrote any, and `0-0` — the only
    // cursor that reaches this line, the rest having been caught as unreachable above —
    // has missed nothing.
    if (oldest === undefined) return floor !== undefined

    // Below the oldest retained entry, which is a gap unless the stream can vouch that
    // that entry is its first — that nothing was ever dropped from in front of it.
    return !(floor?.created === true && floor.id === oldest)
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        const reply = await subscriber.xread('BLOCK', blockMs, 'STREAMS', key, lastRead)
        if (!running) return
        if (reply === null) continue // block expired with nothing new
        for (const [, entries] of reply) {
          for (const [id, fields] of entries) {
            lastRead = id
            const event = toEvent(id, fields)
            if (event !== null && sink !== undefined) sink(event)
          }
        }
      } catch (error) {
        if (!running) return
        onError(error)
        // Back off briefly rather than spinning on a dead connection.
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  // A stream that already exists gets its floor recorded now, off the publish path, and
  // recorded as `adopted`: entries may have been evicted before this process ever looked.
  await writeFloor().catch(onError)

  // Register only after every fallible initialization step. If construction rejects,
  // there is no backplane for the caller to close and therefore no later opportunity to
  // release this process-local diagnostic entry.
  const inUse = keysInUse.get(key) ?? 0
  if (inUse > 0) {
    console.warn(
      `aghoz: a second backplane on stream key "${key}" in this process. Both hubs will ` +
        'receive every event on it, so two feed scopes sharing a key are not separated ' +
        '(PROTOCOL.md §2.4). Give each scope its own scope or key.',
    )
  }
  keysInUse.set(key, inUse + 1)
  void loop()

  return {
    async publish(topic, payload, origin) {
      const id = await redis.xadd(
        key,
        'MAXLEN',
        '~',
        maxLen,
        '*',
        FIELD_TOPIC,
        topic,
        FIELD_PAYLOAD,
        payload,
        ...(origin === undefined || origin === '' ? [] : [FIELD_ORIGIN, origin]),
      )
      if (id === null) throw new Error('XADD returned no id')
      // Awaited rather than fired off, so the floor is durable before the publish is
      // acknowledged: a marker written optimistically and lost to a failing round trip
      // leaves the stream unable to vouch for itself for the rest of its life, and no
      // later publish would know to try again. It runs once — `floorWritten` short-
      // circuits it — so the cost is one round trip on a process's first publish, and a
      // retry on every publish until one succeeds.
      await writeFloor(id).catch(onError)
      return id
    },

    onEvent(next) {
      sink = next
    },

    async replay(cursor, topics): Promise<BackplaneReplay> {
      // The replay set is snapshotted before the loss question is asked, not after. The
      // two reads cannot be one instant across a network, so the order decides which way
      // a trim landing between them is wrong: state read afterwards can only have moved
      // on, which over-reports, while deciding first and reading afterwards would vouch
      // for a range that was evicted in the meantime.
      //
      // `(cursor` is exclusive, which matches "strictly newer than the cursor".
      // One past the cap, so the overflow is detectable rather than inferred.
      const entries = await redis.xrange(key, `(${cursor}`, '+', 'COUNT', maxReplay + 1)
      // Too far behind to serve honestly — see `maxReplay`. Reported as a gap, which is
      // the same answer a trimmed history gives, for the same reason.
      if (entries.length > maxReplay) return { truncated: true, events: [] }

      const truncated = await missedAnything(cursor)

      const wanted = new Set(topics)
      const events: BackplaneEvent[] = []
      for (const [id, fields] of entries) {
        const event = toEvent(id, fields)
        if (event !== null && wanted.has(event.topic)) events.push(event)
      }

      return { truncated, events }
    },

    async cursor() {
      return newestId(redis, key)
    },

    async close() {
      if (!running) return
      running = false
      // Released here rather than left behind, so a test or a process that recreates a
      // backplane on the same key does not accumulate a warning it cannot act on.
      const held = keysInUse.get(key) ?? 0
      if (held <= 1) keysInUse.delete(key)
      else keysInUse.set(key, held - 1)
      // The reader may be parked in a BLOCK; disconnect is what interrupts it.
      subscriber.disconnect?.()
      await subscriber.quit?.().catch(() => {})
    },
  }
}

async function newestId(redis: RedisLike, key: string): Promise<string> {
  const newest = await redis.xrevrange(key, '+', '-', 'COUNT', 1)
  return newest[0]?.[0] ?? '0-0'
}

/** Undefined rather than `0-0` when the stream is empty: "none" is not "the beginning". */
async function oldestId(redis: RedisLike, key: string): Promise<string | undefined> {
  const oldest = await redis.xrange(key, '-', '+', 'COUNT', 1)
  return oldest[0]?.[0]
}

function toEvent(id: string, fields: string[]): BackplaneEvent | null {
  let topic: string | undefined
  let payload: string | undefined
  let origin: string | undefined
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === FIELD_TOPIC) topic = fields[i + 1]
    else if (fields[i] === FIELD_PAYLOAD) payload = fields[i + 1]
    else if (fields[i] === FIELD_ORIGIN) origin = fields[i + 1]
  }
  // An entry written by something else sharing the key is skipped rather than
  // delivered as a malformed event. An absent origin is normal, not malformed.
  if (topic === undefined || payload === undefined) return null
  return origin === undefined ? { id, topic, payload } : { id, topic, payload, origin }
}

/**
 * §2.1 — compare by parsed halves.
 *
 * Duplicated rather than imported so this package keeps no runtime dependency on the
 * server's internals; the shared corpus covers the rule.
 */
function compareIds(a: string, b: string): number {
  const [aMs = 0, aSeq = 0] = a.split('-').map(Number)
  const [bMs = 0, bSeq = 0] = b.split('-').map(Number)
  if (aMs !== bMs) return aMs < bMs ? -1 : 1
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1
  return 0
}
