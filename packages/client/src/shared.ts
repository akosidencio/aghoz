/**
 * One connection for every tab of an origin — PROTOCOL.md §9.1.
 *
 * Five tabs is currently five connections, five replay scans on every reconnect, and five
 * of the browser's six HTTP/1.1 slots. This holds the stream in one tab and fans out to
 * the rest over a `BroadcastChannel`.
 *
 * ## Election
 *
 * The leader is **whoever holds a Web Lock**, and nothing else. Every tab requests the
 * same exclusive lock and never releases it; the browser grants it to one, queues the
 * rest, and — this is the whole reason — hands it to the next in line the moment the
 * holder's tab goes away, including on a crash or a force-quit that runs no unload
 * handler.
 *
 * So there is no election protocol here, no heartbeat and no timeout to tune. That
 * matters more for this library than for most: a heartbeat election has to pick a
 * liveness timeout, and both ends of that choice are bad. Too short and a garbage-collect
 * pause in the leader elects a second one, so the same event is delivered twice from two
 * connections. Too long and every tab is blind for the timeout after a crash — which is
 * silent staleness, the one failure §0 exists to eliminate, reintroduced by the very
 * feature meant to be an optimisation.
 *
 * Where `navigator.locks` is missing there is no fallback, on purpose: [`createClient`]
 * is used per tab, exactly as before. Degrading to more connections is correct and
 * boring; degrading to a guessed timeout is neither.
 *
 * Every browser this library targets has it, and so does Node 24 — Node 22 has a
 * `navigator` with no `locks` on it, which is worth knowing when testing, because the two
 * take different paths through the constructor.
 *
 * ## Handoff
 *
 * Every tab tracks the cursor of every event the leader forwards, whether or not it has a
 * handler for that topic. A tab promoted to leader therefore already knows where the
 * shared stream had reached, and resumes from it. Anything the old leader received but
 * had not broadcast is re-delivered by the server's replay and deduped by id, which is
 * the same trade §4.5 already makes locally.
 *
 * ## Membership
 *
 * What the cursor does not carry is *who else is here*. Only the leader tracks which tab
 * wants which topics, and a lock handoff conveys one bit — that is the whole reason to
 * use one. So a new leader announces itself and every tab answers with its topics, which
 * is the only protocol in this file. Rebuilding the union from the answers is what makes
 * it safe: a tab that has gone away cannot answer, so there is no stale registry to prune
 * and no way for a tab that did not move to quietly leave the union.
 */

import {
  Client,
  type ClientState,
  type CutoverListener,
  type EventMeta,
  type GapReason,
  type Handler,
  type HandlerErrorListener,
  type RequestHeaders,
} from './client.js'
import { compareIds } from './parser.js'

/**
 * The part of [`Client`] that a shared connection also provides.
 *
 * Framework packages accept this rather than the concrete class, so `@aghoz/react`,
 * `@aghoz/vue` and `@aghoz/svelte` work with a shared connection unchanged.
 */
export interface AghozClient {
  readonly state: ClientState
  readonly cursor: string | undefined
  readonly originId: string
  readonly rejected: boolean
  subscribe(topic: string, handler: Handler): () => void
  onGap(listener: (reason: GapReason, topics: readonly string[]) => void): () => void
  onCutover(listener: CutoverListener): () => void
  onHandlerError(listener: HandlerErrorListener): () => void
  onStateChange(listener: (state: ClientState) => void): () => void
  reconnect(): void
  close(): void
}

/** The subset of `navigator.locks` this needs. Injectable so it can be tested off-browser. */
export interface LockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>
}

/** The subset of `BroadcastChannel` this needs. */
export interface Channel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

export interface SharedClientOptions {
  url: string
  initialCursor?: string
  onGap?: (reason: GapReason, topics: readonly string[]) => void
  onDenied?: (topics: readonly string[]) => void
  /**
   * §9.3 — fires in every tab when the shared connection reopens carrying a topic its
   * cursor was never a baseline for.
   *
   * The leader decides, because the leader owns the connection, and the answer is
   * broadcast rather than recomputed per tab: a follower does not know when the shared
   * stream reopened or what set it reopened with. A tab that had nothing to do with
   * the widening hears it too and invalidates a query it could have kept — one
   * refetch, on a topic somebody in this browser just started watching.
   */
  onCutover?: CutoverListener
  /** §9.2 — a handler in *this* tab threw after the cursor had advanced past it. */
  onHandlerError?: HandlerErrorListener
  onError?: (error: unknown) => void
  onStateChange?: (state: ClientState) => void
  originId?: string
  debounceMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  /** Fetch credentials mode. Use `include` for cross-origin cookie authentication. */
  credentials?: RequestCredentials
  /** Static headers or a factory re-evaluated whenever the leader reconnects. */
  headers?: RequestHeaders
  fetch?: typeof globalThis.fetch
  /**
   * Scopes the lock and the channel.
   *
   * Two hubs mounted in one application must not share a connection — their topic sets
   * and their authorization are different — so give each its own name. Defaults to the
   * url, which is the right answer for the overwhelmingly common single-mount case.
   */
  name?: string
  /** Defaults to `navigator.locks`. */
  locks?: LockManager
  /** Defaults to `new BroadcastChannel(name)`. */
  channel?: () => Channel
}

// ---------------------------------------------------------------- the tab protocol

type FromFollower =
  | { t: 'hello'; from: string; topics: string[] }
  | { t: 'topics'; from: string; topics: string[] }
  | { t: 'bye'; from: string }
  | { t: 'reconnect' }

type FromLeader =
  /**
   * A leader announcing itself, and the only message that is broadcast rather than
   * addressed. Every tab answers it with a `hello`, which is how a leader that has just
   * been promoted learns who is out there and what they want — see `#becomeLeader`.
   */
  | { t: 'lead'; from: string }
  | { t: 'welcome'; to: string; cursor?: string; state: ClientState; rejected: boolean }
  | { t: 'event'; id: string; topic: string; data: string; origin?: string }
  | { t: 'state'; state: ClientState; rejected: boolean }
  | { t: 'gap'; reason: GapReason; topics: string[] }
  | { t: 'cutover'; topics: string[]; cursor?: string }
  | { t: 'denied'; topics: string[] }

type Message = FromFollower | FromLeader

export class SharedClient implements AghozClient {
  readonly #options: SharedClientOptions
  readonly #id = randomId()
  readonly #originId: string
  readonly #channel: Channel
  readonly #handlers = new Map<string, Set<Handler>>()
  readonly #gapListeners = new Set<(reason: GapReason, topics: readonly string[]) => void>()
  readonly #cutoverListeners = new Set<CutoverListener>()
  readonly #handlerErrorListeners = new Set<HandlerErrorListener>()
  readonly #stateListeners = new Set<(state: ClientState) => void>()

  /** Set once this tab wins the lock. Undefined while it is a follower. */
  #leader: Client | undefined
  /** Leader only: every tab's topic set, including this one's. */
  readonly #byTab = new Map<string, string[]>()
  /** Leader only: the union currently subscribed, so a change can be diffed. */
  readonly #subscribed = new Map<string, () => void>()

  #cursor: string | undefined
  #state: ClientState = 'connecting'
  #rejected = false
  #closed = false
  #lockAbort: AbortController | undefined

  constructor(options: SharedClientOptions) {
    this.#options = options
    this.#originId = options.originId ?? randomId()
    this.#cursor = options.initialCursor

    const name = options.name ?? `aghoz:${options.url}`

    // Checked before the channel is opened, not after. A throw between the two would
    // leave a BroadcastChannel nobody holds a reference to and nobody can close.
    const locks = options.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks
    if (locks === undefined) {
      throw new TypeError(
        'aghoz: navigator.locks is unavailable, so a leader cannot be elected safely. ' +
          'Use createClient() per tab instead.',
      )
    }

    this.#channel =
      options.channel?.() ?? (new BroadcastChannel(name) as unknown as Channel)
    // Node only, and a no-op in a browser: a channel that keeps the event loop alive
    // stops `node script.js` from ever exiting. Same reason the client unrefs its timers.
    ;(this.#channel as { unref?: () => void }).unref?.()
    this.#channel.addEventListener('message', (event) => {
      this.#receive(event.data as Message)
    })

    // Never resolves. Holding the lock *is* being the leader, and the browser reclaims it
    // when this tab dies — which is the entire election.
    this.#lockAbort = new AbortController()
    void locks
      .request(name, { mode: 'exclusive', signal: this.#lockAbort.signal }, () => {
        this.#becomeLeader()
        return new Promise<void>(() => {})
      })
      .catch(() => {
        // An aborted request is `close()` on a tab that never led. Nothing to report.
      })

    // Announced regardless of the lock, because the answer arrives asynchronously and a
    // leader that already exists should start forwarding to this tab immediately. If
    // there is no leader yet, nobody answers and nothing is lost: whichever tab wins the
    // lock announces itself, and every tab answers that.
    this.#announce()
  }

  get state(): ClientState {
    return this.#state
  }

  get cursor(): string | undefined {
    return this.#cursor
  }

  get originId(): string {
    return this.#originId
  }

  get rejected(): boolean {
    return this.#rejected
  }

  /** Whether this tab currently holds the connection. Diagnostics, and worth surfacing. */
  get isLeader(): boolean {
    return this.#leader !== undefined
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.#handlers.get(topic)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(topic, set)
    }
    set.add(handler)
    this.#publishTopics()

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.#handlers.get(topic)
      if (current === undefined) return
      current.delete(handler)
      if (current.size === 0) this.#handlers.delete(topic)
      this.#publishTopics()
    }
  }

  onGap(listener: (reason: GapReason, topics: readonly string[]) => void): () => void {
    this.#gapListeners.add(listener)
    return () => {
      this.#gapListeners.delete(listener)
    }
  }

  /** §9.3 — see `Client.onCutover`. Broadcast by the leader, fired in every tab. */
  onCutover(listener: CutoverListener): () => void {
    this.#cutoverListeners.add(listener)
    return () => {
      this.#cutoverListeners.delete(listener)
    }
  }

  /** §9.2 — see `Client.onHandlerError`. Local to this tab; handlers are not shared. */
  onHandlerError(listener: HandlerErrorListener): () => void {
    this.#handlerErrorListeners.add(listener)
    return () => {
      this.#handlerErrorListeners.delete(listener)
    }
  }

  onStateChange(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  reconnect(): void {
    if (this.#closed) return
    this.#rejected = false
    if (this.#leader !== undefined) this.#leader.reconnect()
    else this.#send({ t: 'reconnect' })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#send({ t: 'bye', from: this.#id })
    this.#leader?.close()
    this.#leader = undefined
    // Releases the lock, so a queued tab is promoted immediately rather than after this
    // tab's process finally exits.
    this.#lockAbort?.abort()
    this.#lockAbort = undefined
    this.#channel.close()
    this.#setState('closed')
  }

  // ------------------------------------------------------------------- leader

  /**
   * Wins the lock, opens the connection, and asks the other tabs who they are.
   *
   * The registry of who wants what lives only in the leader, and a Web Lock handoff
   * carries nothing across — that is the point of it: the lock conveys exactly one bit,
   * which is why there is no election protocol to get wrong. So a promoted tab starts
   * knowing only its own topics, and the tabs that did not move have no reason to
   * announce themselves again. Their topics would simply leave the union: they keep
   * their state, their cursor and their callbacks, and stop receiving. Silent staleness
   * — §0's one unacceptable failure — reintroduced by the feature that exists to save
   * connections.
   *
   * So the new leader announces itself and every tab answers. Rebuilding the registry
   * from the answers rather than trying to inherit the old one is the same trade the
   * lock makes: a tab that has gone away cannot answer, so what comes back is the union
   * of the tabs that actually exist rather than a map that has to be pruned.
   */
  #becomeLeader(): void {
    if (this.#closed) return
    this.#byTab.set(this.#id, this.#ownTopics())

    this.#leader = new Client({
      url: this.#options.url,
      // A fresh origin no tab uses, so the inner client filters nothing. Origin is a
      // per-tab decision — a follower's own echo must reach it to be skipped there — so
      // the shared connection stays a pure transport and every tab judges for itself.
      originId: randomId(),
      ...(this.#cursor !== undefined && { initialCursor: this.#cursor }),
      ...(this.#options.debounceMs !== undefined && { debounceMs: this.#options.debounceMs }),
      ...(this.#options.baseBackoffMs !== undefined && { baseBackoffMs: this.#options.baseBackoffMs }),
      ...(this.#options.maxBackoffMs !== undefined && { maxBackoffMs: this.#options.maxBackoffMs }),
      ...(this.#options.credentials !== undefined && { credentials: this.#options.credentials }),
      ...(this.#options.headers !== undefined && { headers: this.#options.headers }),
      ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      onGap: (reason, topics) => {
        this.#send({ t: 'gap', reason, topics: [...topics] })
        this.#fireGap(reason, topics)
      },
      onCutover: (topics, cursor) => {
        this.#send({ t: 'cutover', topics: [...topics], ...(cursor !== undefined && { cursor }) })
        this.#fireCutover(topics, cursor)
      },
      onDenied: (topics) => {
        this.#send({ t: 'denied', topics: [...topics] })
        this.#options.onDenied?.(topics)
      },
      onError: (error) => this.#options.onError?.(error),
      onStateChange: (state) => {
        const rejected = this.#leader?.rejected ?? false
        this.#send({ t: 'state', state, rejected })
        this.#rejected = rejected
        this.#setState(state)
      },
    })

    this.#syncUnion()

    // Answers arrive after the connection has already opened on this tab's own topics,
    // and each one widens the union. Widening reconnects with the cursor this tab has
    // been tracking all along (§9.3), so the events that arrived for another tab's topic
    // in that window are replayed rather than skipped — the same trade the handoff
    // itself makes.
    this.#send({ t: 'lead', from: this.#id })
  }

  /** Leader only: subscribe the inner client to the union of every tab's topics. */
  #syncUnion(): void {
    if (this.#leader === undefined) return
    const union = new Set<string>()
    for (const topics of this.#byTab.values()) for (const t of topics) union.add(t)

    for (const [topic, unsubscribe] of [...this.#subscribed]) {
      if (union.has(topic)) continue
      unsubscribe()
      this.#subscribed.delete(topic)
    }
    for (const topic of union) {
      if (this.#subscribed.has(topic)) continue
      this.#subscribed.set(
        topic,
        this.#leader.subscribe(topic, (data, meta) => this.#fanOut(data, meta)),
      )
    }
  }

  /** Leader only: one arriving frame, to every tab including this one. */
  #fanOut(data: string, meta: { id: string; topic: string; origin?: string }): void {
    this.#send({
      t: 'event',
      id: meta.id,
      topic: meta.topic,
      data,
      ...(meta.origin !== undefined && { origin: meta.origin }),
    })
    this.#deliver(meta.id, meta.topic, data, meta.origin)
  }

  // ----------------------------------------------------------------- messages

  #receive(message: Message): void {
    if (this.#closed) return

    // ---- a leader answering its followers ---------------------------------
    if (this.#leader !== undefined) {
      switch (message.t) {
        case 'hello':
          this.#byTab.set(message.from, message.topics)
          this.#send({
            t: 'welcome',
            to: message.from,
            ...(this.#leader.cursor !== undefined && { cursor: this.#leader.cursor }),
            state: this.#leader.state,
            rejected: this.#leader.rejected,
          })
          this.#syncUnion()
          return
        case 'topics':
          this.#byTab.set(message.from, message.topics)
          this.#syncUnion()
          return
        case 'bye':
          this.#byTab.delete(message.from)
          this.#syncUnion()
          return
        case 'reconnect':
          this.#leader.reconnect()
          return
        default:
          return
      }
    }

    // ---- a follower listening to its leader -------------------------------
    switch (message.t) {
      case 'lead':
        // A leader that knows nothing about this tab — either it was just promoted, or
        // this tab's own announcement was made before there was anyone to hear it.
        // Answering is the whole membership protocol; the `welcome` that comes back
        // re-syncs this tab's state and cursor with whoever is holding the stream now.
        this.#announce()
        return
      case 'welcome':
        if (message.to !== this.#id) return
        // Only adopt a cursor that is ahead of ours. A tab constructed with an
        // `initialCursor` from its own page load may legitimately be further along than
        // a leader that has been idle, and moving backwards would replay events this tab
        // has already applied.
        if (message.cursor !== undefined && this.#ahead(message.cursor)) {
          this.#cursor = message.cursor
        }
        this.#rejected = message.rejected
        this.#setState(message.state)
        // Sent now rather than at construction: until the leader answered there was
        // nobody to tell, and components mount before the first round trip completes.
        this.#publishTopics()
        return
      case 'event':
        this.#deliver(message.id, message.topic, message.data, message.origin)
        return
      case 'state':
        this.#rejected = message.rejected
        this.#setState(message.state)
        return
      case 'gap':
        this.#fireGap(message.reason, message.topics)
        return
      case 'cutover':
        this.#fireCutover(message.topics, message.cursor)
        return
      case 'denied':
        this.#options.onDenied?.(message.topics)
        return
      default:
        return
    }
  }

  #send(message: Message): void {
    try {
      this.#channel.postMessage(message)
    } catch (error) {
      // A closed channel during teardown, or a structured-clone failure. Neither should
      // take the tab's own delivery down with it.
      this.#options.onError?.(error)
    }
  }

  /** Tells whoever is leading that this tab is here, and what it wants. */
  #announce(): void {
    this.#send({ t: 'hello', from: this.#id, topics: this.#ownTopics() })
  }

  #publishTopics(): void {
    const topics = this.#ownTopics()
    if (this.#leader !== undefined) {
      this.#byTab.set(this.#id, topics)
      this.#syncUnion()
      return
    }
    this.#send({ t: 'topics', from: this.#id, topics })
  }

  #ownTopics(): string[] {
    return [...this.#handlers.keys()].sort()
  }

  // ----------------------------------------------------------------- delivery

  /**
   * One event, to this tab's handlers.
   *
   * Identical on the leader and on a follower, deliberately: the cursor advance, the
   * dedupe and the §6.0 origin skip are per-tab decisions, and a leader that took a
   * different path would be a second implementation of the rule that decides whether an
   * event is shown.
   */
  #deliver(id: string, topic: string, data: string, origin?: string): void {
    // §9.2 — replay repeats, and so does a handoff: a promoted leader resumes from the
    // last id it was told about, so everything after it arrives again.
    if (!this.#ahead(id)) return
    this.#cursor = id

    // §6.0 — the cursor advances first even when the event is skipped. Skipping the
    // cursor too would replay every skipped event on the next reconnect, forever.
    if (origin !== undefined && origin === this.#originId) return

    const set = this.#handlers.get(topic)
    if (set === undefined) return
    const meta = { id, topic, ...(origin !== undefined && { origin }) }
    for (const handler of [...set]) {
      try {
        handler(data, meta)
      } catch (error) {
        // §9.2 — the cursor above has already moved past this event and no reconnect
        // will bring it back, so the failure has to name the topic it belongs to.
        this.#fireHandlerError(error, meta)
      }
    }
  }

  #ahead(id: string): boolean {
    return this.#cursor === undefined || compareIds(id, this.#cursor) > 0
  }

  #fireGap(reason: GapReason, topics: readonly string[]): void {
    this.#options.onGap?.(reason, topics)
    for (const listener of [...this.#gapListeners]) {
      try {
        listener(reason, topics)
      } catch (error) {
        this.#options.onError?.(error)
      }
    }
  }

  #fireCutover(topics: readonly string[], cursor: string | undefined): void {
    this.#options.onCutover?.(topics, cursor)
    for (const listener of [...this.#cutoverListeners]) {
      try {
        listener(topics, cursor)
      } catch (error) {
        this.#options.onError?.(error)
      }
    }
  }

  #fireHandlerError(error: unknown, meta: EventMeta): void {
    this.#options.onHandlerError?.(error, meta)
    for (const listener of [...this.#handlerErrorListeners]) {
      try {
        listener(error, meta)
      } catch (listenerError) {
        this.#options.onError?.(listenerError)
      }
    }
    this.#options.onError?.(error)
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onStateChange?.(state)
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state)
      } catch (error) {
        this.#options.onError?.(error)
      }
    }
  }
}

/**
 * A connection shared across every tab of this origin.
 *
 * Drop-in for [`createClient`] wherever `navigator.locks` exists, which is every browser
 * this library targets. Throws where it does not, rather than guessing at an election —
 * fall back to `createClient` per tab, which is correct, just chattier.
 */
export function createSharedClient(options: SharedClientOptions): SharedClient {
  return new SharedClient(options)
}

function randomId(): string {
  const c: { randomUUID?: () => string } | undefined = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}
