/**
 * Topic-set cutover — PROTOCOL.md §9.3.
 *
 * A cursor names a position in one total sequence, and §9.3 spells out why that is not
 * the same as a baseline for every topic. An event for a newly added topic `b` can be
 * assigned id 11 while the live connection carries only `a`; an `a` event with id 12
 * then advances the cursor. The replacement connection for `a,b` resumes from 12, so
 * `b`'s id 11 is never replayed and no history was truncated — nothing is lost from the
 * hub's point of view, and everything is lost from `b`'s.
 *
 * The hole is exactly this: **a topic is covered by the cursor only over the range for
 * which it was in the open topic set.** That is a fact the client knows and nobody else
 * does — the server sees one request with one topic list and cannot tell a new topic
 * from an old one, and the application sees a hook mount rather than a cursor. So the
 * client tracks it here and reports it, and a cache adapter turns the report into a
 * refetch after the replacement stream opens.
 *
 * This module is pure: no IO, no clock, no timers. It is the client's equivalent of the
 * server's `hub.ts`, and for the same reason — `conformance/client/vectors.json` owns
 * its behaviour, so a second client implementation cannot quietly answer differently.
 * **Do not add behaviour here that the client corpus does not pin down.**
 */

/**
 * Which topics the client's cursor can vouch for.
 *
 * One rule, applied per topic: a topic is covered when the cursor it was last covered
 * up to is the cursor the client holds now. Everything else in here is bookkeeping to
 * keep that comparison honest across connection replacement.
 */
export class Coverage {
  /**
   * The cursor a topic inherits when it has never been in an open set.
   *
   * On a first page load this is the §5 cursor read alongside the page's data, and it
   * is what keeps `open()` silent there: every component mounting in that first render
   * pass — including the ones that mount a tick late — joins at the same baseline the
   * data was read at, so none of them needs a refetch. Without this seeding, adopting
   * the cutover signal would mean a refetch storm on every page load, which is the
   * cost §5 exists to remove.
   */
  readonly #origin: string | undefined
  #cursor: string | undefined
  /** The topics of the connection that is open now, covered up to the live cursor. */
  #open: readonly string[] = []
  /** Topics no longer in an open set, and the cursor their coverage stopped at. */
  readonly #frozen = new Map<string, string | undefined>()

  constructor(initialCursor?: string) {
    this.#origin = initialCursor
    this.#cursor = initialCursor
  }

  /** The cursor last advanced to, for tests and for the corpus adapter. */
  get cursor(): string | undefined {
    return this.#cursor
  }

  /**
   * §9.2 — the cursor advanced to `id`.
   *
   * Called for every data frame the client accepts, including the ones it skips as its
   * own echo (§6.0), because the cursor advances for those too and the coverage
   * question is about the cursor rather than about delivery.
   */
  advance(id: string): void {
    this.#cursor = id
  }

  /**
   * The client is about to replace the open connection with one for `topics`.
   *
   * Freezes coverage for the connection being replaced and nothing else. It decides
   * nothing: an abort races the last chunk the old connection had already buffered, so
   * the cursor can still move once after this call, and a decision taken here would
   * have been taken against a cursor that was about to be superseded.
   *
   * `topics` is the incoming set. It is accepted rather than needed so that a caller
   * cannot forget which set the freeze belongs to, and so a future rule about the
   * incoming set has somewhere to live.
   */
  sync(_topics: readonly string[]): void {
    for (const topic of this.#open) this.#frozen.set(topic, this.#cursor)
    this.#open = []
  }

  /**
   * The connection for `topics` is open. Returns the topics that opened without a
   * baseline, sorted.
   *
   * Reported *after* the stream is open rather than when the topic is added, and the
   * order is the contract: a refetch issued before the replacement stream exists has
   * its own window — anything published between the snapshot and the open is lost
   * again, which is §5's failure re-created one layer up. Deciding here rather than at
   * the topic change is also what makes a connection attempt that never opened cost
   * nothing: §9.4 backs off through failures, and a cutover consumed by a failed
   * attempt would leave the topic uncovered with nothing left to report it.
   *
   * A reported gap on this same connection does not suppress the cutover. The two
   * answer different questions and an adapter subscribing to both may invalidate
   * twice; one redundant refetch is the right side to be wrong on, and suppressing
   * would mean deciding which signal is authoritative in the one case where both are.
   */
  open(topics: readonly string[]): string[] {
    const live = new Set(this.#open)
    const uncovered = topics.filter((topic) => {
      // Already carried by the connection this one replaces without a topic change —
      // an ordinary §9.4 reconnect, which resumes from a cursor that covers the set.
      if (live.has(topic)) return false
      const coveredAt = this.#frozen.has(topic) ? this.#frozen.get(topic) : this.#origin
      return coveredAt !== this.#cursor
    })

    this.#open = [...topics]
    // Live topics track the cursor rather than a frozen value; a stale entry left here
    // would make the topic look uncovered the next time the set changed.
    for (const topic of topics) this.#frozen.delete(topic)

    return uncovered.sort()
  }
}

export function createCoverage(initialCursor?: string): Coverage {
  return new Coverage(initialCursor)
}
