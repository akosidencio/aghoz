// Sets one version across every published package, because the conformance guarantee
// is only meaningful if the packages that share the corpus ship together.
//
//   node scripts/set-version.mjs 0.1.0

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>')
  process.exit(2)
}

const root = new URL('..', import.meta.url).pathname

// Derived rather than listed, for the same reason as check-invariants.mjs: a list left
// behind by a new package bumps some manifests and not others, and the lockstep
// invariant then fails on a release that looked done.
const PACKAGES = readdirSync(`${root}packages`)
  .map((entry) => `packages/${entry}`)
  .filter((rel) => statSync(`${root}${rel}`).isDirectory())
  .sort()

for (const pkg of PACKAGES) {
  const path = `${root}${pkg}/package.json`
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.version = version
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`  ${manifest.name} → ${version}`)
}
console.log('\nrun `node scripts/check-invariants.mjs` to confirm lockstep.')

// The Rust workspace version, kept in step with the packages.
//
// The crates are not published to crates.io — they exist to be linked by bindings — but a
// workspace whose version disagrees with the packages built from it is a question nobody
// wants to have to answer during an incident.
const cargo = `${root}Cargo.toml`
const before = readFileSync(cargo, 'utf8')
const after = before.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
if (after === before) {
  console.error('  WARNING: Cargo.toml workspace version not found — left unchanged')
} else {
  writeFileSync(cargo, after)
  console.log(`  Cargo.toml workspace → ${version}`)
}

// The crates depend on `aghoz-core` by path AND version, because a path-only dependency
// cannot be published. That version is a second place the number lives, so it moves with
// the first one rather than being noticed at the next release.
for (const manifest of ['abi/Cargo.toml', 'bindings/node/Cargo.toml']) {
  const file = `${root}${manifest}`
  const source = readFileSync(file, 'utf8')
  const updated = source.replace(
    /(aghoz-core = \{ path = "[^"]*", version = ")[^"]*(" \})/,
    `$1${version}$2`,
  )
  if (updated === source) {
    console.error(`  WARNING: ${manifest} aghoz-core dependency not found — left unchanged`)
  } else {
    writeFileSync(file, updated)
    console.log(`  ${manifest} aghoz-core → ${version}`)
  }
}
