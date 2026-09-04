/**
 * @aghoz/svelte
 *
 * One connection for the whole app, and a store where you render.
 *
 * A thin wrapper over `@aghoz/client`: it owns reactivity and lifetime, and nothing else.
 * Every protocol decision — gap detection, replay, the cursor — belongs to the client and
 * is not restated here.
 *
 * ## Stores rather than runes
 *
 * These are `svelte/store` readables, which work unchanged in Svelte 4 and Svelte 5 and
 * are plain JavaScript — no `.svelte.js` file, no compiler step in this package's build,
 * and no rune syntax that pins it to one major version. Svelte 5 still auto-subscribes to
 * a store with `$topicStore`, so the rendering code is identical either way.
 *
 * It also buys the lifetime for free. A readable's start function runs on the first
 * subscriber and its returned teardown runs when the last one leaves, so `$` auto-
 * subscription in a component *is* the subscription lifecycle: nothing to remember to
 * clean up, and no leak when a component is destroyed.
 */

import { getContext, setContext } from 'svelte'
import { readable, type Readable } from 'svelte/store'
import {
  createClient,
  type Client,
  type ClientOptions,
  type CutoverListener,
  type HandlerErrorListener,
  type ClientState,
  type EventMeta,
  type GapReason,
  type RequestHeaders,
} from '@aghoz/client'

const AGHOZ_KEY = Symbol.for('aghoz.client')

export interface SetAghozOptions {
  /** The mounted path, e.g. `/events`. */
  url: string
  /**
   * The cursor read alongside the page's initial data — see PROTOCOL.md §5.
   *
   * Without it, anything published between the server rendering this page and the browser
   * opening the stream is lost with nothing reported.
   */
  initialCursor?: string
  /**
   * Fires when the accepted stream is provably incomplete. Wiring this to a refetch
   * prevents the UI from trusting that incomplete stream; database-to-publish and
   * handler failures are outside this signal.
   */
  onGap?: (reason: GapReason, topics: readonly string[]) => void
  /**
   * §9.3 — a topic mounted late, and the stream that now carries it resumed from a
   * cursor that was never a baseline for it. Refetch these topics.
   */
  onCutover?: CutoverListener
  /**
   * §9.2 — a subscriber threw after the cursor had already advanced past the event.
   * Anything folding payloads into state must invalidate the named topic here.
   */
  onHandlerError?: HandlerErrorListener
  onDenied?: (topics: readonly string[]) => void
  onError?: (error: unknown) => void
  /** Fetch credentials mode. Use `include` for cross-origin cookie authentication. */
  credentials?: RequestCredentials
  /** Static headers or a factory re-evaluated on every reconnect. */
  headers?: RequestHeaders
  /** Injectable transport for tests or runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch
  /** Supply your own client — useful in tests, or to share one across two apps. */
  client?: Client
}

/**
 * Creates the connection and puts it in context.
 *
 * Call it during the initialisation of a root component — `setContext` requires that:
 *
 * ```svelte
 * <script>
 *   import { setAghozClient } from '@aghoz/svelte'
 *   export let cursor
 *   setAghozClient({ url: '/events', initialCursor: cursor })
 * </script>
 * ```
 *
 * Closing is the caller's, deliberately. Svelte has no scope-dispose hook reachable from a
 * plain function, and a client tied to the root component's `onDestroy` would be closed by
 * a hot reload in development. In a browser application the connection lives as long as
 * the page, so there is usually nothing to do; on a server-rendered pass, close it with
 * the request.
 */
export function setAghozClient(options: SetAghozOptions): Client {
  const client =
    options.client ??
    createClient({
      url: options.url,
      ...(options.initialCursor !== undefined && { initialCursor: options.initialCursor }),
      ...(options.onGap !== undefined && { onGap: options.onGap }),
      ...(options.onCutover !== undefined && { onCutover: options.onCutover }),
      ...(options.onHandlerError !== undefined && { onHandlerError: options.onHandlerError }),
      ...(options.onDenied !== undefined && { onDenied: options.onDenied }),
      ...(options.onError !== undefined && { onError: options.onError }),
      ...(options.credentials !== undefined && { credentials: options.credentials }),
      ...(options.headers !== undefined && { headers: options.headers }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    } satisfies ClientOptions)

  setContext(AGHOZ_KEY, client)
  return client
}

/**
 * The client from context.
 *
 * `client` overrides it, which is what lets every store below be used outside component
 * initialisation — in a `.ts` module, or a test — where `getContext` would throw.
 */
export function getAghozClient(client?: Client): Client {
  if (client !== undefined) return client

  let fromContext: Client | undefined
  try {
    fromContext = getContext<Client | undefined>(AGHOZ_KEY)
  } catch {
    // Svelte throws its own "called outside component initialization" here, which says
    // what went wrong internally but not what to do about it. Both failures — no context
    // and no component — have the same two fixes, so they get the same message.
    fromContext = undefined
  }

  if (fromContext === undefined) {
    throw new Error(
      'getAghozClient: no client available. Either call setAghozClient() in a parent ' +
        'component, or pass one explicitly as `client` — needed outside component ' +
        'initialisation, where Svelte context cannot be read.',
    )
  }
  return fromContext
}

export interface TopicOptions<T> {
  /**
   * Turns the wire payload into a value. Defaults to `JSON.parse`, which mirrors the
   * server serialising non-string data.
   *
   * Publishing a raw string that is not valid JSON needs `parse: (s) => s`. The default is
   * not a guess-and-fall-back, because a silent fallback would make `publish(topic, '42')`
   * sometimes a number and sometimes a string.
   */
  parse?: (raw: string) => T
  /** Overrides the client taken from context. */
  client?: Client
}

function parser<T>(options?: TopicOptions<T>): (raw: string) => T {
  return options?.parse ?? ((raw: string) => JSON.parse(raw) as T)
}

/**
 * A store of the most recent value on a topic.
 *
 * This is a last-value cell. It is the right shape for a dashboard number or a status, and
 * the wrong shape for a growing collection — an event carrying one new order gives you
 * that order, not the list containing it. Use `topicReducer` for collections.
 *
 * The client is resolved when this is called, not when the store is first subscribed to,
 * so a missing context fails at the point the mistake was made rather than later.
 */
export function topic<T>(name: string, initial: T, options?: TopicOptions<T>): Readable<T> {
  const client = getAghozClient(options?.client)
  const parse = parser(options)

  return readable<T>(initial, (set) => client.subscribe(name, (raw) => set(parse(raw))))
}

/**
 * Folds events into a store — the shape a collection needs.
 *
 * `topic` cannot express a live list, which is one of the use cases this library claims to
 * serve, so this exists rather than leaving every consumer to hand-roll the same
 * append-and-cap reducer.
 *
 * State resets to `initial` whenever the subscriber count returns to zero and rises again,
 * because that is when the underlying subscription is remade. A fold is only meaningful
 * over an unbroken run of events, and carrying stale state across a gap in subscription
 * would be a fold over events it never saw.
 */
export function topicReducer<S, T = unknown>(
  name: string,
  reducer: (state: S, value: T, meta: EventMeta) => S,
  initial: S,
  options?: TopicOptions<T>,
): Readable<S> {
  const client = getAghozClient(options?.client)
  const parse = parser(options)

  return readable<S>(initial, (set) => {
    // Published as well as held. A readable retains its last value across a stop, so
    // without this a new run would report the *previous* run's final state until the
    // next event arrived — and then jump to a fold that had silently dropped it. The
    // accumulator and what subscribers see have to start from the same place.
    let state = initial
    set(state)

    return client.subscribe(name, (raw, meta) => {
      state = reducer(state, parse(raw), meta)
      set(state)
    })
  })
}

/**
 * Subscribes without holding state — for toasts, invalidation, imperative work.
 *
 * Returns the unsubscribe function. Unlike the stores above there is no `$` subscription to
 * govern the lifetime, so this one is yours to end — usually in `onDestroy`.
 */
export function topicEffect<T = unknown>(
  name: string,
  fn: (value: T, meta: EventMeta) => void | Promise<void>,
  options?: TopicOptions<T>,
): () => void {
  const client = getAghozClient(options?.client)
  const parse = parser(options)

  return client.subscribe(name, (raw, meta) => {
    return fn(parse(raw), meta)
  })
}

/** A store of the live connection state, for a status indicator. */
export function connectionState(client?: Client): Readable<ClientState> {
  const resolved = getAghozClient(client)

  // The initial value is read at call time and again when the store starts, because the
  // connection may have opened in between — a change listener alone would leave the
  // indicator showing `idle` until something happened to the connection.
  return readable<ClientState>(resolved.state, (set) => {
    set(resolved.state)
    return resolved.onStateChange(set)
  })
}

export type {
  Client,
  ClientState,
  GapReason,
  EventMeta,
  CutoverListener,
  HandlerErrorListener,
} from '@aghoz/client'
export type { Readable } from 'svelte/store'
