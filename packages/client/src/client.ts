/**
 * The connection manager — PROTOCOL.md §9.
 *
 * One connection per client, whatever the number of topics. Tracks the cursor,
 * reconnects with it, dedupes what replay repeats, and reports both loss conditions
 * through one callback.
 */

import { SseParser, compareIds } from './parser.js'
import { Coverage } from './coverage.js'

export type GapReason = 'history-truncated' | 'slow-consumer'
export type ClientState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface EventMeta {
  readonly id: string
  readonly topic: string
  /**
   * §6.0 — the origin the publisher echoed, when there was one.
   *
   * Almost no application wants this: a client already skips its own echoes, so by the
   * time a handler runs this is somebody else's id or nothing at all. It is exposed for
   * one caller — a shared connection forwarding frames to other tabs, which must pass the
   * origin along so each tab can decide for itself whether the event is its own.
   */
  readonly origin?: string
}

export type Handler = (data: string, meta: EventMeta) => void

/**
 * §9.3 — topics whose replacement stream just opened without a baseline.
 *
 * `cursor` is the position they were joined at, for an application that pairs its
 * snapshots with cursors and can decide for itself whether a refetch is needed.
 */
export type CutoverListener = (topics: readonly string[], cursor: string | undefined) => void

/**
 * §9.2 — a subscriber callback threw, after the cursor had already advanced past the
 * event that fed it.
 */
export type HandlerErrorListener = (error: unknown, meta: EventMeta) => void

/**
 * Headers added to every stream attempt.
 *
 * A factory is evaluated again on reconnect, which is what bearer-token clients need:
 * a token refreshed while the old stream was open must not be captured forever. Cookies
 * usually need only `credentials: 'include'` instead.
 */
export type RequestHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>)

export interface ClientOptions {
  /** The mounted path, e.g. `/events`. */
  url: string
  /**
   * §5 — the cursor read alongside the page's initial data.
   *
   * Without it the stream starts from "now" and anything published between the data
   * fetch and the stream opening is lost with nothing reported. That window is on
   * every first page load, so this is not an optimisation.
   */
  initialCursor?: string
  /** §8 — fires for both loss conditions, at most once per connection attempt. */
  onGap?: (reason: GapReason, topics: readonly string[]) => void
  /** §4.3 — topics the server refused; the connection stayed open for the rest. */
  onDenied?: (topics: readonly string[]) => void
  /**
   * §9.3 — a topic was added to a live client and its stream has now reopened, but the
   * cursor it resumed from was never a baseline for that topic.
   *
   * Fires after the replacement stream is open, so a refetch answering it cannot open
   * a second window of its own. Read an authoritative snapshot for these topics; a
   * cache adapter should invalidate them.
   */
  onCutover?: CutoverListener
  /**
   * §9.2 — a handler threw. The cursor has already advanced past that event and will
   * not replay it, so state folded from payloads is now behind by one event with
   * nothing else to report it.
   *
   * Also reached by a parse failure inside an adapter's handler, which is the common
   * case. Invalidate the affected topic here; `onError` is the same failure without
   * the topic, kept for logging.
   */
  onHandlerError?: HandlerErrorListener
  onError?: (error: unknown) => void
  onStateChange?: (state: ClientState) => void
  /**
   * §6.0 — this client's origin id, so it can skip the events it caused itself.
   *
   * Send it with your writes (a header on the mutation is the usual place), have the
   * server pass it to `publish` as `origin`, and the echo that comes back over the
   * stream is dropped here — the tab that acted has already applied the write's own
   * response, and applying it again is the double-render that reads as a bug.
   *
   * Generated per client when omitted, so the feature costs nothing to adopt: read
   * `client.originId` and attach it. Opaque and unauthenticated — it says which
   * connection to skip and nothing more.
   */
  originId?: string
  /** §9.1 — collapses a render pass worth of mounts into one connection. */
  debounceMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  /**
   * Fetch credentials mode for the stream request. Defaults to `same-origin`, matching
   * `fetch`. Cross-origin cookie authentication therefore opts in with `include`.
   */
  credentials?: RequestCredentials
  /**
   * Application headers added to every connection attempt.
   *
   * Use a factory for rotating bearer tokens. It runs on the initial connection and on
   * every reconnect. Protocol-owned `Accept` and `Last-Event-ID` values cannot be
   * overridden here.
   */
  headers?: RequestHeaders
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch
}

export class Client {
  readonly #options: Required<
    Omit<ClientOptions, 'initialCursor' | 'originId' | 'headers'>
  > & {
    initialCursor?: string
    headers: RequestHeaders
  }
  readonly #originId: string
  readonly #handlers = new Map<string, Set<Handler>>()
  /**
   * Listeners registered after construction — see `onGap` and `onStateChange` below.
   *
   * The constructor options stay a single callback each, because they belong to
   * whoever created the client. These exist because a *second* consumer needs the same
   * signal: a cache adapter has to invalidate on a gap, and it cannot take the
   * application's callback away from it.
   */
  readonly #gapListeners = new Set<(reason: GapReason, topics: readonly string[]) => void>()
  readonly #stateListeners = new Set<(state: ClientState) => void>()
  readonly #cutoverListeners = new Set<CutoverListener>()
  readonly #handlerErrorListeners = new Set<HandlerErrorListener>()
  /** §9.3 — which topics the cursor can vouch for. Pure; see `coverage.ts`. */
  readonly #coverage: Coverage

  #cursor: string | undefined
  #state: ClientState = 'idle'
  #abort: AbortController | undefined
  #debounce: ReturnType<typeof setTimeout> | undefined
  #openTopicsKey = ''
  #attempt = 0
  #closed = false
  /** Stopped by a 400 or 403 rather than by `close()`. Cleared by `reconnect()`. */
  #fatal = false
  /** Diagnostics — the connection-reuse tests assert on this. */
  #connections = 0

  constructor(options: ClientOptions) {
    this.#options = {
      url: options.url,
      onGap: options.onGap ?? (() => {}),
      onDenied: options.onDenied ?? (() => {}),
      onCutover: options.onCutover ?? (() => {}),
      onHandlerError: options.onHandlerError ?? (() => {}),
      onError: options.onError ?? (() => {}),
      onStateChange: options.onStateChange ?? (() => {}),
      debounceMs: options.debounceMs ?? 10,
      baseBackoffMs: options.baseBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      credentials: options.credentials ?? 'same-origin',
      headers: options.headers ?? {},
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      ...(options.initialCursor !== undefined && { initialCursor: options.initialCursor }),
    }
    this.#originId = options.originId ?? randomOrigin()
    this.#cursor = options.initialCursor
    this.#coverage = new Coverage(options.initialCursor)
  }

  get state(): ClientState {
    return this.#state
  }

  get cursor(): string | undefined {
    return this.#cursor
  }

  /**
   * §6.0 — this client's origin id. Attach it to your writes.
   *
   * ```js
   * fetch('/api/orders', { method: 'POST', headers: { 'x-origin': client.originId } })
   * ```
   */
  get originId(): string {
    return this.#originId
  }

  get connectionCount(): number {
    return this.#connections
  }

  /**
   * True when the server rejected the stream with a 400 or 403 and the client stopped.
   *
   * `state` alone cannot tell you this: it reads `closed` both for a client someone
   * called `close()` on and for one the server turned away, and only the second is
   * worth showing a "sign in again" prompt for. Cleared by `reconnect()`.
   */
  get rejected(): boolean {
    return this.#fatal
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.#handlers.get(topic)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(topic, set)
    }
    set.add(handler)
    this.#scheduleSync()

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.#handlers.get(topic)
      if (current === undefined) return
      current.delete(handler)
      if (current.size === 0) this.#handlers.delete(topic)
      this.#scheduleSync()
    }
  }

  /**
   * Registers an additional gap listener. Returns its unsubscribe function.
   *
   * Fires alongside the `onGap` constructor option, never instead of it — an adapter
   * subscribing here must not silently disconnect the application's own gap banner.
   */
  onGap(listener: (reason: GapReason, topics: readonly string[]) => void): () => void {
    this.#gapListeners.add(listener)
    return () => {
      this.#gapListeners.delete(listener)
    }
  }

  /**
   * §9.3 — registers a cutover listener. Returns its unsubscribe function.
   *
   * Fires once per opened connection that carries a topic the cursor was never a
   * baseline for, with those topics and the cursor they joined at. A cache adapter
   * invalidates them; an application that pairs snapshots with cursors can compare.
   *
   * It cannot fire for the topics a client was constructed with: they all inherit the
   * initial cursor, which is precisely the baseline the page's data was read at.
   */
  onCutover(listener: CutoverListener): () => void {
    this.#cutoverListeners.add(listener)
    return () => {
      this.#cutoverListeners.delete(listener)
    }
  }

  /**
   * §9.2 — registers a handler-failure listener. Returns its unsubscribe function.
   *
   * The cursor advances before handlers run, on purpose: one throwing component must
   * not stall every topic multiplexed onto the connection. The consequence is that a
   * failed handler is a *silently* stale projection — the event will not come round
   * again — so anything folding payloads into state needs this signal to invalidate
   * with. `onError` sees the same failures without knowing which topic they were for.
   */
  onHandlerError(listener: HandlerErrorListener): () => void {
    this.#handlerErrorListeners.add(listener)
    return () => {
      this.#handlerErrorListeners.delete(listener)
    }
  }

  /**
   * Registers a connection-state listener. Returns its unsubscribe function.
   *
   * Fires on change only. Read `state` for the current value: a listener registered
   * after the connection opened would otherwise never hear anything until it dropped.
   */
  onStateChange(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  /**
   * Connects again now, from whatever state the client is in.
   *
   * Two uses, and the first is the one that matters. A 400 or 403 stops the client for
   * good — see `#run` — so a session that expired mid-stream leaves a dead client that
   * no amount of waiting will revive. Once the application has re-authenticated, this
   * is how it says so. Wire it to the same place that handles a 401 from your ordinary
   * API calls.
   *
   * The second is impatience: it drops any live connection and reconnects immediately
   * with the backoff reset, for a "reconnect now" control or a `visibilitychange`
   * handler that does not want to wait out a 30-second backoff.
   *
   * Resuming is unaffected — the cursor is kept, so this replays rather than restarts.
   * A client that has been `close()`d stays closed; that is a deliberate end of life,
   * not a failure to recover from.
   */
  reconnect(): void {
    if (this.#closed) return
    this.#fatal = false
    this.#attempt = 0
    this.#abort?.abort()
    this.#abort = undefined
    // Forces `#sync` to treat the current topic set as changed. Without it a client
    // whose topics never varied would compare equal and decline to do anything.
    this.#openTopicsKey = ''
    this.#scheduleSync()
  }

  close(): void {
    this.#closed = true
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#abort?.abort()
    this.#abort = undefined
    this.#setState('closed')
  }

  // ---------------------------------------------------------------- internals

  #setState(state: ClientState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onStateChange(state)
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state)
      } catch (error) {
        // A listener that throws must not stop the others, and must not surface as an
        // unhandled rejection out of the read loop.
        this.#options.onError(error)
      }
    }
  }

  #topics(): string[] {
    // Sorted so that the same set derived in a different mount order does not read as
    // a change and trigger a pointless reconnect.
    return [...this.#handlers.keys()].sort()
  }

  /** §9.1 — debounced, so ten components mounting in one pass open one connection. */
  #scheduleSync(): void {
    if (this.#closed) return
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined
      void this.#sync()
    }, this.#options.debounceMs)
    // Node only: never hold the process open for a debounce tick.
    ;(this.#debounce as { unref?: () => void }).unref?.()
  }

  async #sync(): Promise<void> {
    if (this.#closed) return
    const topics = this.#topics()
    const key = topics.join(',')
    if (key === this.#openTopicsKey && this.#abort !== undefined) return

    this.#abort?.abort()
    this.#abort = undefined
    this.#openTopicsKey = key

    // §9.3 — decided before the connection is replaced, because the answer depends on
    // the cursor the outgoing connection stopped at. Deciding it after the new stream
    // opened would compare every topic against a cursor that had already moved on.
    this.#coverage.sync(topics)

    if (key === '') {
      this.#setState('idle')
      return
    }
    this.#attempt = 0
    void this.#run(key)
  }

  /** §9.3, §9.4 — the connect/read/backoff loop for one topic set. */
  async #run(key: string): Promise<void> {
    while (!this.#closed && this.#openTopicsKey === key) {
      const controller = new AbortController()
      this.#abort = controller
      this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting')

      let gapFired = false
      const reportGap = (reason: GapReason, topics: readonly string[]): void => {
        // §8.1 — history-truncated is signalled by both a header and a frame on
        // purpose. The application must see it once.
        if (gapFired) return
        gapFired = true
        this.#options.onGap(reason, topics)
        for (const listener of [...this.#gapListeners]) {
          try {
            listener(reason, topics)
          } catch (error) {
            this.#options.onError(error)
          }
        }
      }

      try {
        const topics = this.#topics()
        const res = await this.#connect(topics, controller.signal)
        this.#connections++

        if (!res.ok) {
          if (res.status === 400 || res.status === 403) {
            // Not transient. Retrying cannot fix a rejected topic or a denied one, and
            // a backoff loop against a 403 is just a slow denial-of-service against
            // your own server. Recovery is explicit: `reconnect()`, once the
            // application has done something about it — logged back in, usually.
            this.#fatal = true
            this.#options.onError(
              new Error(`aghoz: stream rejected with ${res.status}`),
            )
            this.#setState('closed')
            return
          }
          const retryAfter = Number(res.headers.get('retry-after'))
          await this.#sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : this.#backoff(),
          )
          this.#attempt++
          continue
        }

        // §4.4 — the whole reason this client is built on fetch rather than
        // EventSource: the checkpoint is only readable here.
        if (res.headers.get('last-event-id-checkpoint') === 'earliest') {
          reportGap('history-truncated', topics)
        }

        this.#setState('open')
        this.#attempt = 0
        // §9.3 — after the stream is open, never before. A refetch issued while no
        // stream exists has the same window §5 describes, one layer up.
        const cutover = this.#coverage.open(topics)
        if (cutover.length > 0) this.#reportCutover(cutover)
        await this.#read(res, reportGap, topics)
      } catch (error) {
        if (controller.signal.aborted || this.#closed) return
        this.#options.onError(error)
      }

      if (this.#closed || this.#openTopicsKey !== key) return
      await this.#sleep(this.#backoff())
      this.#attempt++
    }
  }

  async #connect(topics: readonly string[], signal: AbortSignal): Promise<Response> {
    // §4.1 — each topic is encoded individually, then joined. Encoding the joined
    // string instead would escape the separators and produce one absurd topic.
    const query = new URLSearchParams()
    const encoded = topics.map(encodeURIComponent).join(',')

    const configured =
      typeof this.#options.headers === 'function'
        ? await this.#options.headers()
        : this.#options.headers
    const headers = new Headers(configured)
    // These are protocol state, not application configuration. In particular, accepting
    // a stale Last-Event-ID from configured headers would make the client replay from a
    // position different from the cursor it exposes.
    headers.set('accept', 'text/event-stream')
    headers.delete('last-event-id')
    let url = `${this.#options.url}?topics=${encoded}`
    if (this.#cursor !== undefined) {
      headers.set('last-event-id', this.#cursor)
      // §4.1 — the query fallback is sent too, so a runtime that strips the header
      // still resumes rather than silently restarting from now.
      query.set('last_event_id', this.#cursor)
      url += `&${query.toString()}`
    }

    return this.#options.fetch(url, {
      headers,
      signal,
      cache: 'no-store',
      credentials: this.#options.credentials,
    })
  }

  async #read(
    res: Response,
    reportGap: (reason: GapReason, topics: readonly string[]) => void,
    topics: readonly string[],
  ): Promise<void> {
    if (res.body === null) return
    const reader = res.body.getReader()
    const parser = new SseParser()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        const events = done ? parser.end() : parser.push(value)

        for (const event of events) {
          if (event.event !== undefined && event.event.charCodeAt(0) === 126) {
            this.#control(event.event, event.data, reportGap, topics)
            continue
          }
          if (event.event === undefined || event.id === undefined) continue

          // §9.2 — replay can repeat what we already delivered, because the server
          // registers the subscriber before snapshotting history.
          if (this.#cursor !== undefined && compareIds(event.id, this.#cursor) <= 0) continue
          this.#cursor = event.id
          this.#coverage.advance(event.id)

          // §6.0 — our own write, coming back. The cursor advances first and on purpose:
          // skipping that too would make every skipped event replay on the next
          // reconnect, and a busy tab would re-receive its own history forever.
          if (event.origin !== undefined && event.origin === this.#originId) continue

          const set = this.#handlers.get(event.event)
          if (set === undefined) continue
          const meta: EventMeta = {
            id: event.id,
            topic: event.event,
            ...(event.origin !== undefined && { origin: event.origin }),
          }
          for (const handler of [...set]) {
            try {
              handler(event.data, meta)
            } catch (error) {
              // One misbehaving component must not tear down the shared connection —
              // but the cursor is already past this event, so whoever folds payloads
              // into state has to hear about it by topic. §9.2.
              this.#reportHandlerError(error, meta)
            }
          }
        }
        if (done) return
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  /** Fans a cutover out to the option and every registered listener. */
  #reportCutover(topics: readonly string[]): void {
    this.#options.onCutover(topics, this.#cursor)
    for (const listener of [...this.#cutoverListeners]) {
      try {
        listener(topics, this.#cursor)
      } catch (error) {
        this.#options.onError(error)
      }
    }
  }

  /** Fans a handler failure out to the option, every listener, and `onError`. */
  #reportHandlerError(error: unknown, meta: EventMeta): void {
    this.#options.onHandlerError(error, meta)
    for (const listener of [...this.#handlerErrorListeners]) {
      try {
        listener(error, meta)
      } catch (listenerError) {
        this.#options.onError(listenerError)
      }
    }
    // Still reported as a plain error, so existing logging keeps working and adopting
    // the topic-scoped signal is not a condition of seeing the failure at all.
    this.#options.onError(error)
  }

  #control(
    name: string,
    data: string,
    reportGap: (reason: GapReason, topics: readonly string[]) => void,
    topics: readonly string[],
  ): void {
    let parsed: { reason?: string; topics?: string[] } = {}
    try {
      parsed = JSON.parse(data) as typeof parsed
    } catch {
      return // §11 — an unparseable control frame is ignored, not fatal.
    }

    if (name === '~gap') {
      const reason: GapReason = parsed.reason === 'slow-consumer' ? 'slow-consumer' : 'history-truncated'
      reportGap(reason, parsed.topics ?? topics)
    } else if (name === '~denied') {
      this.#options.onDenied(parsed.topics ?? [])
    }
    // §11 — any other `~` frame is ignored, which is what lets new ones be added.
  }

  /** §9.4 — exponential with equal jitter, capped. */
  #backoff(): number {
    const ceiling = Math.min(
      this.#options.maxBackoffMs,
      this.#options.baseBackoffMs * 2 ** Math.min(this.#attempt, 20),
    )
    return ceiling / 2 + Math.random() * (ceiling / 2)
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      ;(t as { unref?: () => void }).unref?.()
    })
  }
}

export function createClient(options: ClientOptions): Client {
  return new Client(options)
}

/**
 * A per-client origin id.
 *
 * `crypto.randomUUID` where it exists — every browser this library targets, and Node 19+
 * — with a plain random fallback so a client constructed in an exotic runtime still gets
 * one rather than throwing. Uniqueness only has to hold among the tabs one user has
 * open; §6.0 gives the value no authority, so a collision costs a skipped render, not a
 * leak.
 */
function randomOrigin(): string {
  const c: { randomUUID?: () => string } | undefined = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `o-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}
