/**
 * @aghoz/vue
 *
 * One connection for the whole app, and a composable where you render.
 *
 * A thin wrapper over `@aghoz/client`: it owns reactivity and lifetime, and nothing else.
 * Every protocol decision — gap detection, replay, the cursor — belongs to the client and
 * is not restated here.
 */

import {
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  toValue,
  watch,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from 'vue'
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

/** Injection key for the client, exported so an application can provide its own. */
export const AGHOZ_KEY: InjectionKey<Client> = Symbol.for('aghoz.client') as InjectionKey<Client>

export interface ProvideAghozOptions {
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
 * Creates the connection and provides it to descendants.
 *
 * Call it once, in the setup of a root component:
 *
 * ```ts
 * provideAghoz({ url: '/events', initialCursor: props.cursor })
 * ```
 *
 * A client this function created is closed when the surrounding effect scope is disposed.
 * One passed in via `client` is left alone — it is the caller's.
 */
export function provideAghoz(options: ProvideAghozOptions): Client {
  const provided = options.client
  const client =
    provided ??
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

  provide(AGHOZ_KEY, client)
  if (provided === undefined) onScopeDispose(() => client.close())
  return client
}

/**
 * The client for the current component.
 *
 * `client` overrides the injected one. It exists so a composable can be used outside a
 * component — in a bare `effectScope`, or a test — where `inject` has nothing to read.
 */
export function useAghoz(client?: Client): Client {
  const resolved = client ?? inject(AGHOZ_KEY, null)
  if (resolved === null) {
    throw new Error('useAghoz: no client provided — call provideAghoz() in a parent setup()')
  }
  return resolved
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
  /** Overrides the injected client. */
  client?: Client
}

/**
 * Subscribes for as long as the current effect scope lives, following a topic that may
 * itself be reactive.
 *
 * The subscription is torn down and remade when the topic changes, and torn down when the
 * scope ends — `watch`'s cleanup does both, which is why this is a `watch` rather than a
 * plain call plus an `onScopeDispose`.
 */
function subscribe(
  client: Client,
  topic: MaybeRefOrGetter<string>,
  handler: (raw: string, meta: EventMeta) => void,
): () => void {
  return watch(
    () => toValue(topic),
    (name, _previous, onCleanup) => {
      onCleanup(client.subscribe(name, handler))
    },
    { immediate: true },
  )
}

/**
 * Subscribes to a topic and returns the most recent value.
 *
 * This is a last-value cell. It is the right shape for a dashboard number or a status, and
 * the wrong shape for a growing collection — an event carrying one new order gives you
 * that order, not the list containing it. Use `useTopicReducer` for collections.
 *
 * The ref is **shallow**. A deep one would wrap every payload in a reactive proxy, so an
 * object you published would not be `===` the object you receive, and any identity check
 * downstream would silently stop working. Payloads arrive whole and are replaced whole;
 * there is nothing for deep reactivity to do but cost.
 */
export function useTopic<T>(
  topic: MaybeRefOrGetter<string>,
  initial: T,
  options?: TopicOptions<T>,
): Readonly<ShallowRef<T>> {
  const client = useAghoz(options?.client)
  const parse = options?.parse ?? ((raw: string) => JSON.parse(raw) as T)
  const value = shallowRef<T>(initial)

  subscribe(client, topic, (raw) => {
    value.value = parse(raw)
  })

  return value
}

/** Subscribes without holding state — for toasts, invalidation, imperative work. */
export function useTopicEffect<T = unknown>(
  topic: MaybeRefOrGetter<string>,
  fn: (value: T, meta: EventMeta) => void,
  options?: TopicOptions<T>,
): void {
  const client = useAghoz(options?.client)
  const parse = options?.parse ?? ((raw: string) => JSON.parse(raw) as T)

  subscribe(client, topic, (raw, meta) => {
    fn(parse(raw), meta)
  })
}

/**
 * Folds events into state — the shape a collection needs.
 *
 * `useTopic` cannot express a live list, which is one of the use cases this library claims
 * to serve, so this exists rather than leaving every consumer to hand-roll the same
 * append-and-cap reducer.
 */
export function useTopicReducer<S, T = unknown>(
  topic: MaybeRefOrGetter<string>,
  reducer: (state: S, value: T, meta: EventMeta) => S,
  initial: S,
  options?: TopicOptions<T>,
): Readonly<ShallowRef<S>> {
  const client = useAghoz(options?.client)
  const parse = options?.parse ?? ((raw: string) => JSON.parse(raw) as T)
  const state = shallowRef<S>(initial)

  subscribe(client, topic, (raw, meta) => {
    state.value = reducer(state.value, parse(raw), meta)
  })

  return state
}

/** The live connection state, for a status indicator. */
export function useConnectionState(client?: Client): Readonly<Ref<ClientState>> {
  const resolved = useAghoz(client)
  // Read once as well as on change: the connection may already have opened before this
  // component mounted, and a change listener alone would leave the indicator showing
  // `idle` until something happened to the connection.
  const state = shallowRef<ClientState>(resolved.state)
  const stop = resolved.onStateChange((next) => {
    state.value = next
  })
  onScopeDispose(stop)
  return state
}

export type {
  Client,
  ClientState,
  GapReason,
  EventMeta,
  CutoverListener,
  HandlerErrorListener,
} from '@aghoz/client'
