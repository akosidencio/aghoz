/**
 * The client corpus's view of this implementation — `conformance/client/runner.mjs`.
 *
 * The mirror of `@aghoz/server`'s adapter, and here for the same reason: the runner
 * must not import a package's private shape, or the corpus stops being portable to a
 * client written in another language and becomes a test of this one.
 */

import { Coverage } from './coverage.js'

export interface CoverageProbe {
  sync(topics: readonly string[]): void
  open(topics: readonly string[]): string[]
  advance(id: string): void
}

export function newCoverage(initialCursor: string | null): CoverageProbe {
  return new Coverage(initialCursor ?? undefined)
}
