// Repository invariants that no unit test would naturally catch, and that decay
// silently if nothing enforces them.
//
//   node scripts/check-invariants.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const failures = []

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push({ label, message: error.message })
    console.error(`  FAIL  ${label}\n          ${error.message}`)
  }
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function json(path) {
  return JSON.parse(read(path))
}

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`
    if (entry === 'node_modules' || entry === 'dist' || entry === 'target' || entry === '.git') continue
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

// Derived, not listed. A hardcoded list silently stops checking the moment a package
// is added — which is exactly what had happened: `fastify` and `redis` were never
// covered by the dependency or lockstep invariants below.
const PACKAGES = readdirSync(join(ROOT, 'packages'))
  .map((entry) => `packages/${entry}`)
  .filter((rel) => statSync(join(ROOT, rel)).isDirectory())
  .sort()

console.log('\nrepository invariants\n')

// ---------------------------------------------------------------------------
check('the product name never appears on the wire', () => {
  // DECISIONS.md D0 defers the name, and that is only affordable while renaming stays
  // a find-and-replace. The moment a header, event name or field carries the name,
  // every deployed client pins it forever.
  const name = json('package.json').name.replace(/-workspace$/, '')
  const wireish = /(?:^|[^\w])(?:id|event|data|retry):|headers?\[|writeHead\(|setHeader\(/

  const offenders = []
  for (const pkg of PACKAGES) {
    for (const file of walk(`${pkg}/src`)) {
      const source = read(file)
      for (const [i, line] of source.split('\n').entries()) {
        // Only literal strings matter; prose in comments is fine.
        const strings = line.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []
        if (!strings.some((s) => s.toLowerCase().includes(name))) continue
        if (!wireish.test(line) && !/['"`][a-z-]*-?cursor|checkpoint/i.test(line)) continue
        offenders.push(`${file}:${i + 1}`)
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`name appears in wire-adjacent literals: ${offenders.join(', ')}`)
  }
  return `"${name}" absent from all wire literals`
})

// ---------------------------------------------------------------------------
check('shipped packages declare no third-party runtime dependencies', () => {
  // The whole install story rests on this. A single transitive dependency turns
  // "npm install and go" into a supply-chain conversation.
  const offenders = []
  for (const pkg of PACKAGES) {
    const manifest = json(`${pkg}/package.json`)
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@aghoz/')) offenders.push(`${manifest.name} → ${dep}`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join(', '))
  return 'workspace-internal only'
})

// ---------------------------------------------------------------------------
check('packages version in lockstep', () => {
  // The conformance guarantee is only real if the packages that share the corpus ship
  // together. Divergent versions make "these agree" an untestable claim.
  const versions = new Map()
  for (const pkg of PACKAGES) {
    const manifest = json(`${pkg}/package.json`)
    versions.set(manifest.name, manifest.version)
  }
  const distinct = new Set(versions.values())
  if (distinct.size !== 1) {
    throw new Error(
      `versions diverge: ${[...versions].map(([n, v]) => `${n}@${v}`).join(', ')}`,
    )
  }
  return `all at ${[...distinct][0]}`
})

// ---------------------------------------------------------------------------
check('the protocol core performs no IO', () => {
  // hub.ts and registry.ts are what the corpus owns. Once they can touch a socket or
  // the clock, the corpus stops being able to pin their behaviour.
  //
  // coverage.ts is the client's equivalent — §9.3's rule, owned by the client corpus —
  // and it is here for the same reason: a coverage decision that could read a clock
  // would stop being reproducible from a vector.
  const offenders = []
  for (const file of [
    'packages/server/src/hub.ts',
    'packages/server/src/registry.ts',
    'packages/client/src/coverage.ts',
  ]) {
    const source = read(file)
    for (const pattern of [/from 'node:/, /require\(/, /Date\.now\(/, /Math\.random\(/]) {
      if (pattern.test(source)) offenders.push(`${file} contains ${pattern}`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '))
  return 'hub.ts, registry.ts and coverage.ts are pure'
})

// ---------------------------------------------------------------------------
check('the client has no dependency on the server package', () => {
  // They are tested against each other, but a runtime edge would defeat the point of
  // the corpus: the two implementations must be independently correct.
  const manifest = json('packages/client/package.json')
  const runtime = Object.keys(manifest.dependencies ?? {})
  if (runtime.includes('@aghoz/server')) {
    throw new Error('@aghoz/client must not depend on the server at runtime')
  }
  return 'independent'
})

// ---------------------------------------------------------------------------
check('every conformance vector carries a description', () => {
  // A vector whose failure message does not say what is wrong is worth very little at
  // three in the morning.
  //
  // Both corpora, because there are two: the hub's and the client's. Listing one here
  // would have left the other unchecked from the day it was added, which is the same
  // mistake the group lists below already made once.
  let total = 0
  let groupCount = 0
  const missing = []
  for (const path of ['conformance/vectors.json', 'conformance/client/vectors.json']) {
    const corpus = json(path)
    // Derived from the corpus rather than listed, because a hardcoded group list silently
    // stops checking when a category is added — which is exactly what happened when
    // §6.0's `origin` group arrived and eleven vectors went unchecked.
    const groups = Object.keys(corpus).filter((k) => Array.isArray(corpus[k]))
    for (const group of groups) {
      for (const vector of corpus[group]) {
        if (typeof vector.desc !== 'string' || vector.desc.length < 8) {
          missing.push(`${path} ${group}/${vector.id}`)
        }
      }
      total += corpus[group].length
    }
    groupCount += groups.length
  }
  if (missing.length > 0) throw new Error(`undescribed vectors: ${missing.join(', ')}`)
  return `${total} vectors across ${groupCount} groups, in two corpora`
})

// ---------------------------------------------------------------------------
check('every HTTP scenario carries a description and does something', () => {
  const corpus = json('conformance/http/scenarios.json')
  const groups = Object.keys(corpus).filter((k) => Array.isArray(corpus[k]))
  const bad = []
  for (const group of groups) {
    for (const scenario of corpus[group]) {
      if (typeof scenario.desc !== 'string' || scenario.desc.length < 8) {
        bad.push(`${group}/${scenario.id}: no description`)
      }
      // A scenario with no assertion passes against every implementation, including one
      // that does nothing at all — which is worse than having no scenario, because it
      // reports coverage that does not exist.
      const asserts = (scenario.steps ?? []).some(
        (s) => s.op.startsWith('expect') || s.op === 'get-cursor' || s.expect !== undefined,
      )
      if (!asserts) bad.push(`${group}/${scenario.id}: asserts nothing`)
    }
  }
  if (bad.length > 0) throw new Error(bad.join(', '))
  const total = groups.reduce((n, g) => n + corpus[g].length, 0)
  return `${total} scenarios across ${groups.length} groups`
})

// ---------------------------------------------------------------------------
check('the adapter guide points at files that still exist', () => {
  // ADAPTERS.md tells a porter which files to copy and which to ignore. That table is
  // prose, and prose drifts: rename `hub.ts` or move the test app and the guide quietly
  // starts directing contributors at nothing. Nothing else would catch it, because no
  // test imports a document.
  const guide = read('ADAPTERS.md')
  const start = guide.indexOf('## Reading the reference implementation')
  if (start === -1) {
    throw new Error('ADAPTERS.md has lost its "Reading the reference implementation" section')
  }
  // Bounded to the section, not "to the end of the file" — later sections name the two
  // corpora, and sweeping those in makes this check fail on files that are not the
  // subject of the table at all.
  const end = guide.indexOf('\n## ', start + 1)
  const table = guide.slice(start, end === -1 ? undefined : end)

  // Derived from the document rather than listed here, so a row added later is checked
  // without anyone remembering to update this script.
  const paths = [...new Set(table.match(/`[\w./-]+\.(?:ts|mjs|rs|json|md)`/g) ?? [])].map((m) =>
    m.slice(1, -1),
  )
  if (paths.length < 5) {
    throw new Error(`only ${paths.length} file references found — the table has lost rows`)
  }

  const missing = paths.filter((p) => {
    try {
      // Bare filenames appear in the "do not copy" row alongside a full path; resolve
      // them against the package that row is about.
      return !statSync(join(ROOT, p.includes('/') ? p : `packages/server/src/${p}`)).isFile()
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(`ADAPTERS.md points at files that do not exist: ${missing.join(', ')}`)
  }

  // The guide tells porters to follow the checklist through these markers. If one is
  // renamed the instruction is unfollowable.
  const handler = read('packages/server/src/create-hub.ts')
  const markers = ['---- §4.1 parse', '---- §4.3 authorize', '---- §4.5 the atomic block']
  const gone = markers.filter((m) => !handler.includes(m))
  if (gone.length > 0) {
    throw new Error(`create-hub.ts has lost the section markers ADAPTERS.md cites: ${gone.join(', ')}`)
  }

  return `${paths.length} files, ${markers.length} section markers`
})

// ---------------------------------------------------------------------------
check('every scenario the adapter guide cites exists in the corpus', () => {
  // The checklist links each rule to the scenario that catches it. A citation pointing at
  // a scenario that was renamed or dropped is worse than no citation: it tells a porter
  // the rule is enforced when nothing enforces it.
  const cited = [...new Set(read('ADAPTERS.md').match(/\bH\d+\b/g) ?? [])]
  if (cited.length === 0) throw new Error('ADAPTERS.md cites no scenarios — the links have been lost')

  const corpus = json('conformance/http/scenarios.json')
  const known = new Set(
    Object.values(corpus)
      .filter(Array.isArray)
      .flatMap((group) => group.map((s) => s.id)),
  )
  const dangling = cited.filter((id) => !known.has(id))
  if (dangling.length > 0) {
    throw new Error(`ADAPTERS.md cites scenarios that no longer exist: ${dangling.join(', ')}`)
  }
  return `${cited.length} of ${known.size} scenarios cited`
})

// ---------------------------------------------------------------------------
check('the README states the exclusions before the install line', () => {
  // Serverless and multi-process are the two ways someone wastes an afternoon before
  // discovering this is the wrong tool. They belong above the fold, permanently.
  const readme = read('README.md')
  const install = readme.indexOf('pnpm add')
  if (install === -1) throw new Error('no install instruction found')
  const head = readme.slice(0, install)
  for (const term of ['serverless', 'multiple processes', 'sync engine']) {
    if (!head.toLowerCase().includes(term)) {
      throw new Error(`"${term}" must appear before the install instruction`)
    }
  }
  return 'serverless, multi-process and sync-engine all disclosed above the fold'
})

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} invariant(s) violated\n`)
  process.exit(1)
}
console.log('all invariants hold\n')
