// Conformance runner for any client-side implementation.
//
//   node runner.mjs <path-to-module>
//
// The module under test must export:
//   newCoverage(initialCursor)  -> {
//     sync(topics)   -> void        the client is about to open for this topic set
//     open(topics)   -> string[]    the stream is open; the topics with no baseline
//     advance(id)    -> void        an accepted data frame moved the cursor
//   }
//     where `initialCursor` is a canonical id or null.
//
// Exits non-zero on any divergence. §9 is the half of the protocol a server cannot
// check for you: nothing on the wire distinguishes a client that reports a cutover from
// one that silently serves a topic it has no baseline for.

import { readFileSync } from 'node:fs'

const target = process.argv[2]
if (!target) {
  console.error('usage: node runner.mjs <path-to-module>')
  process.exit(2)
}

const impl = await import(new URL(target, `file://${process.cwd()}/`).href)
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))

let pass = 0
const failures = []

function check(id, desc, expected, actual) {
  if (expected === actual) { pass++; return }
  failures.push({ id, desc, expected, actual })
}

// ---- §9.3 topic-set cutover
for (const v of vectors.cutover) {
  let actual
  try {
    const coverage = impl.newCoverage(v.initialCursor)
    const reported = []
    for (const [op, arg] of v.ops) {
      if (op === 'sync') coverage.sync(arg)
      else if (op === 'open') reported.push([...coverage.open(arg)])
      else if (op === 'advance') coverage.advance(arg)
      else throw new Error(`unknown op: ${op}`)
    }
    actual = JSON.stringify(reported)
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, JSON.stringify(v.expected), actual)
}

// ---- report
const total = pass + failures.length
if (failures.length === 0) {
  console.log(`client conformance: ${pass}/${total} vectors pass — ${target}`)
  process.exit(0)
}

console.error(`client conformance: ${pass}/${total} pass, ${failures.length} FAIL — ${target}\n`)
for (const f of failures) {
  console.error(`  ${f.id}  ${f.desc}`)
  console.error(`      expected: ${f.expected}`)
  console.error(`      actual:   ${f.actual}\n`)
}
process.exit(1)
