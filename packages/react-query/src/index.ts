/**
 * @aghoz/react-query — topics mapped onto query keys.
 *
 * TanStack Query already owns fetching, caching and staleness. What it has no way to
 * know is *when* the server's answer changed, so the usual approximation is
 * `refetchInterval`: every client asks every few seconds, almost always to be told
 * nothing happened, and the data is stale for up to one interval regardless.
 *
 * This package supplies the missing signal. Keep `useQuery` exactly as it is, delete
 * the interval, and name the topic that invalidates it.
 *
 * ```ts
 * const { data } = useQuery({ queryKey: ['orders'], queryFn: fetchOrders })
 * useTopicInvalidation('org/1/orders', ['orders'])
 * ```
 *
 * **Gaps are the reason this is a package rather than three lines of your own.** A
 * stream that dropped and resumed can be missing accepted events — PROTOCOL.md §8 — and
 * a cache updated only by received payloads would then be silently wrong. Every hook
 * registers for gap notifications and invalidates when one is reported, so that transport
 * failure degrades to a refetch.
 *
 * Two narrower failures are handled the same way, because a cache is where they become
 * visible and nowhere else can see them:
 *
 * - **§9.3 topic-set cutover.** A component that mounts late adds a topic to a live
 *   connection, and the cursor the replacement stream resumes from was never a baseline
 *   for it. Nothing is reported as a gap, because from the hub's point of view nothing
 *   was lost. Every hook invalidates its query when its topic is named in a cutover, so
 *   a lazily mounted subscription refetches once, after its stream is open.
 * - **§9.2 handler failure.** The cursor advances before callbacks run, so an event
 *   whose parse or fold throws is not replayed. `useTopicQueryData` invalidates rather
 *   than leaving an advanced cursor over a projection that never took the update.
 *
 * The database-to-publish boundary stays outside all of this — see `docs/OUTBOX.md`.
 * The ordinary query response remains authoritative throughout.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useAghoz } from '@aghoz/react'
import type { EventMeta } from '@aghoz/react'

export interface TopicQueryOptions<T> {
  /**
   * Turns the wire payload into a value. Defaults to `JSON.parse`, matching the server
   * serialising anything that is not already a string.
   */
  parse?: (raw: string) => T
  /**
   * Subscribe only when true. Default true.
   *
   * Topics are usually derived from something that arrives late — an org id, a
   * selected row — and subscribing to `org/undefined/orders` is a wasted connection
   * churn at best and a 400 at worst.
   */
  enabled?: boolean
  /** Passed to `invalidateQueries` as `exact`. Default false, matching TanStack. */
  exact?: boolean
  /**
   * Collapses a burst of events into one invalidation, in milliseconds. Default 0 —
   * off, so behaviour is exactly one invalidation per event unless you ask otherwise.
   *
   * Worth setting on a hot topic: an invalidation per event on a stream doing hundreds
   * a second is a refetch storm, and it is the one way this can be *heavier* than the
   * polling it replaces.
   */
  debounceMs?: number
}

/** Everything the hooks need from the options, resolved. */
function useResolved<T>(options?: TopicQueryOptions<T>) {
  const parse = options?.parse
  const enabled = options?.enabled ?? true
  const exact = options?.exact ?? false
  const debounceMs = options?.debounceMs ?? 0
  return {
    parse: useMemo(() => parse ?? ((raw: string) => JSON.parse(raw) as T), [parse]),
    enabled,
    exact,
    debounceMs,
  }
}

/**
 * Runs `fn` on a trailing debounce, or immediately when `ms` is 0.
 *
 * Returned as a stable callback plus a cancel, so an unmounting component cannot leave
 * a timer that invalidates a cache it no longer participates in.
 */
function useDebounced(ms: number, fn: () => void): { call: () => void; cancel: () => void } {
  const latest = useRef(fn)
  latest.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  return useMemo(() => {
    const cancel = (): void => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
    }
    return {
      cancel,
      call: () => {
        if (ms <= 0) {
          latest.current()
          return
        }
        if (timer.current !== undefined) return // already scheduled; trailing edge wins
        timer.current = setTimeout(() => {
          timer.current = undefined
          latest.current()
        }, ms)
      },
    }
  }, [ms])
}

/**
 * True when a reported set covers `topic`.
 *
 * An empty list means the whole connection, which is how §8 gaps arrive today. A §9.3
 * cutover always names its topics, so the empty case never applies to it.
 */
function affects(topic: string, topics: readonly string[]): boolean {
  return topics.length === 0 || topics.includes(topic)
}

/**
 * Invalidates `queryKey` whenever `topic` fires, and whenever updates were missed.
 *
 * The drop-in replacement for `refetchInterval`. The event's payload is ignored on
 * purpose: the query function stays the single source of truth for what the data is,
 * so the event only has to say *that* something changed, and no server-side push shape
 * has to match the shape the endpoint returns.
 */
export function useTopicInvalidation(
  topic: string,
  queryKey: QueryKey,
  options?: TopicQueryOptions<unknown>,
): void {
  const client = useAghoz()
  const queryClient = useQueryClient()
  const { enabled, exact, debounceMs } = useResolved(options)

  // Serialised, so an inline `['orders', id]` array does not resubscribe every render.
  const keyId = JSON.stringify(queryKey)
  const keyRef = useRef(queryKey)
  keyRef.current = queryKey

  const invalidate = useDebounced(debounceMs, () => {
    void queryClient.invalidateQueries({ queryKey: keyRef.current, exact })
  })

  useEffect(() => {
    if (!enabled) return
    const unsubscribe = client.subscribe(topic, () => invalidate.call())
    const unlisten = client.onGap((_reason, topics) => {
      if (affects(topic, topics)) invalidate.call()
    })
    // §9.3 — this hook is usually the lazily mounted component the rule is about, and
    // the refetch it needs is the one it would otherwise have to remember to write.
    const uncovered = client.onCutover((topics) => {
      if (affects(topic, topics)) invalidate.call()
    })
    return () => {
      unsubscribe()
      unlisten()
      uncovered()
      invalidate.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyId stands in for queryKey
  }, [client, queryClient, topic, keyId, enabled, exact, invalidate])
}

/**
 * Folds each event straight into the cached value, with no refetch at all.
 *
 * The faster path, and the one with a sharp edge: it is only correct while the client
 * has received every accepted event and every parse/update succeeds. A reported gap does
 * not fold — it invalidates, because at that point only the server knows the state.
 *
 * A parse or updater failure invalidates too, and that is not defensive coding: §9.2 has
 * the cursor advance *before* handlers run, so the event that threw will never be
 * delivered again. Leaving it at an error would mean an advanced cursor sitting over a
 * projection that never took the update, which looks exactly like working software. The
 * failure is re-thrown after the invalidation so the client's `onHandlerError` and
 * `onError` still report it. Same reason `useTopic` cannot serve a
 * collection: an event carries the change, not the state.
 *
 * `undefined` from the updater leaves the cache untouched, which is also what happens
 * before the query has ever resolved — there is nothing to fold into yet, and seeding
 * the cache from an event would publish a value the query function never returned.
 */
export function useTopicQueryData<TData, TEvent = unknown>(
  topic: string,
  queryKey: QueryKey,
  updater: (current: TData | undefined, event: TEvent, meta: EventMeta) => TData | undefined,
  options?: TopicQueryOptions<TEvent>,
): void {
  const client = useAghoz()
  const queryClient = useQueryClient()
  const { parse, enabled, exact, debounceMs } = useResolved(options)

  const keyId = JSON.stringify(queryKey)
  const keyRef = useRef(queryKey)
  keyRef.current = queryKey
  const fold = useRef(updater)
  fold.current = updater

  const invalidate = useDebounced(debounceMs, () => {
    void queryClient.invalidateQueries({ queryKey: keyRef.current, exact })
  })

  useEffect(() => {
    if (!enabled) return
    const unsubscribe = client.subscribe(topic, (raw, meta) => {
      let event: TEvent
      try {
        event = parse(raw)
      } catch (error) {
        // §9.2 — the cursor is already past this event. Only the server knows the
        // state now, so ask it, then let the failure carry on being reported.
        invalidate.call()
        throw error
      }
      try {
        queryClient.setQueryData<TData>(keyRef.current, (current) =>
          current === undefined ? current : fold.current(current, event, meta),
        )
      } catch (error) {
        invalidate.call()
        throw error
      }
    })
    const unlisten = client.onGap((_reason, topics) => {
      if (affects(topic, topics)) invalidate.call()
    })
    const uncovered = client.onCutover((topics) => {
      if (affects(topic, topics)) invalidate.call()
    })
    return () => {
      unsubscribe()
      unlisten()
      uncovered()
      invalidate.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyId stands in for queryKey
  }, [client, queryClient, topic, keyId, enabled, parse, invalidate])
}

export type { EventMeta }
