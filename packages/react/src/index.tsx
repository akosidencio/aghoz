/**
 * @aghoz/react
 *
 * One connection for the whole tree, and a hook where you render.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createClient,
  type Client,
  type ClientOptions,
  type ClientState,
  type CutoverListener,
  type EventMeta,
  type GapReason,
  type HandlerErrorListener,
  type RequestHeaders,
} from '@aghoz/client'

const AghozContext = createContext<Client | null>(null)

export interface AghozProviderProps {
  /** The mounted path, e.g. `/events`. */
  url: string
  /**
   * The cursor read alongside the page's initial data — see PROTOCOL.md §5.
   *
   * Without it, anything published between the server rendering this page and the
   * browser opening the stream is lost with nothing reported.
   */
  initialCursor?: string
  /**
   * Fires when the accepted stream is provably incomplete. Wiring this to a refetch
   * prevents the UI from trusting that incomplete stream; database-to-publish and
   * handler failures are outside this signal.
   */
  onGap?: (reason: GapReason, topics: readonly string[]) => void
  /**
   * PROTOCOL.md §9.3 — a topic mounted late and the replacement stream has opened, but
   * the cursor it resumed from was never a baseline for that topic.
   *
   * Read an authoritative snapshot for the topics named here. `@aghoz/react-query`
   * wires this for you; without a cache adapter it is the application's to handle, and
   * it is the one signal a lazily mounted subscription cannot do without.
   */
  onCutover?: CutoverListener
  /**
   * §9.2 — a subscriber callback threw or rejected, cursor already past the event.
   *
   * `useTopic` and `useTopicReducer` reach this through a parse failure. State folded
   * from payloads is now behind with nothing else to say so, so treat it the way you
   * treat a gap: refetch the topic named in `meta`.
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
  /** Supply your own client — useful in tests, or to share one across two trees. */
  client?: Client
  children?: ReactNode
}

export function AghozProvider(props: AghozProviderProps): ReactNode {
  const {
    url,
    initialCursor,
    onGap,
    onCutover,
    onHandlerError,
    onDenied,
    onError,
    credentials,
    headers,
    fetch,
    client: provided,
    children,
  } = props

  // Callbacks live behind a ref so that a parent re-render with new inline functions
  // does not tear down the connection. Reconnecting because a component re-rendered
  // would discard the cursor and cause exactly the loss this library reports.
  const callbacks = useRef({ onGap, onCutover, onHandlerError, onDenied, onError })
  callbacks.current = { onGap, onCutover, onHandlerError, onDenied, onError }

  const client = useMemo(() => {
    if (provided !== undefined) return provided
    const options: ClientOptions = {
      url,
      onGap: (reason, topics) => callbacks.current.onGap?.(reason, topics),
      onCutover: (topics, cursor) => callbacks.current.onCutover?.(topics, cursor),
      onHandlerError: (error, meta) => callbacks.current.onHandlerError?.(error, meta),
      onDenied: (topics) => callbacks.current.onDenied?.(topics),
      onError: (error) => callbacks.current.onError?.(error),
      ...(initialCursor !== undefined && { initialCursor }),
      ...(credentials !== undefined && { credentials }),
      ...(headers !== undefined && { headers }),
      ...(fetch !== undefined && { fetch }),
    }
    return createClient(options)
    // Request configuration also identifies the connection. Keep header factories and
    // injected fetch functions stable (module scope or useCallback) to avoid replacing it.
  }, [provided, url, initialCursor, credentials, headers, fetch])

  useEffect(() => {
    // Only close a client this provider created; a supplied one is the caller's.
    if (provided !== undefined) return
    return () => client.close()
  }, [client, provided])

  return createElement(AghozContext.Provider, { value: client }, children)
}

export function useAghoz(): Client {
  const client = useContext(AghozContext)
  if (client === null) {
    throw new Error('useAghoz must be used inside a <AghozProvider>')
  }
  return client
}

/** The live connection state, for a status indicator. */
export function useConnectionState(): ClientState {
  const client = useAghoz()
  const [state, setState] = useState<ClientState>(client.state)
  useEffect(() => {
    // Read once on subscribe as well as on change: the connection may already have
    // opened before this component mounted, and a change listener alone would leave
    // the indicator showing `idle` until something happened to the connection.
    setState(client.state)
    return client.onStateChange(setState)
  }, [client])
  return state
}

export interface TopicOptions<T> {
  /**
   * Turns the wire payload into a value. Defaults to `JSON.parse`, which mirrors the
   * server serialising non-string data.
   *
   * Publishing a raw string that is not valid JSON needs `parse: (s) => s`. The
   * default is not a guess-and-fall-back, because a silent fallback would make
   * `publish(topic, '42')` sometimes a number and sometimes a string.
   */
  parse?: (raw: string) => T
}

function useParse<T>(options?: TopicOptions<T>): (raw: string) => T {
  const parse = options?.parse
  return useMemo(() => parse ?? ((raw: string) => JSON.parse(raw) as T), [parse])
}

/**
 * Subscribes to a topic and returns the most recent value.
 *
 * This is a last-value cell. It is the right shape for a dashboard number or a status,
 * and the wrong shape for a growing collection — an event carrying one new order gives
 * you that order, not the list containing it. Use `useTopicReducer` for collections.
 */
export function useTopic<T>(topic: string, initial: T, options?: TopicOptions<T>): T {
  const client = useAghoz()
  const parse = useParse(options)
  const [value, setValue] = useState<T>(initial)

  useEffect(() => {
    return client.subscribe(topic, (raw) => {
      setValue(parse(raw))
    })
  }, [client, topic, parse])

  return value
}

/** Subscribes without holding state — for toasts, invalidation, imperative work. */
export function useTopicEffect<T = unknown>(
  topic: string,
  fn: (value: T, meta: EventMeta) => void | Promise<void>,
  options?: TopicOptions<T>,
): void {
  const client = useAghoz()
  const parse = useParse(options)
  // Behind a ref so an inline callback does not resubscribe on every render, which
  // would churn the topic set and, via §9.3, reconnect the shared stream.
  const handler = useRef(fn)
  handler.current = fn

  useEffect(() => {
    return client.subscribe(topic, (raw, meta) => {
      return handler.current(parse(raw), meta)
    })
  }, [client, topic, parse])
}

/**
 * Folds events into state — the shape a collection needs.
 *
 * `useTopic` cannot express a live list, which is one of the use cases this library
 * claims to serve, so this exists rather than leaving every consumer to hand-roll the
 * same append-and-cap reducer.
 */
export function useTopicReducer<S, T = unknown>(
  topic: string,
  reducer: (state: S, value: T, meta: EventMeta) => S,
  initial: S,
  options?: TopicOptions<T>,
): S {
  const client = useAghoz()
  const parse = useParse(options)
  const [state, setState] = useState<S>(initial)

  const reduce = useRef(reducer)
  reduce.current = reducer

  useEffect(() => {
    return client.subscribe(topic, (raw, meta) => {
      const value = parse(raw)
      setState((current) => reduce.current(current, value, meta))
    })
  }, [client, topic, parse])

  return state
}

export type {
  Client,
  ClientState,
  GapReason,
  EventMeta,
  RequestHeaders,
  CutoverListener,
  HandlerErrorListener,
} from '@aghoz/client'
