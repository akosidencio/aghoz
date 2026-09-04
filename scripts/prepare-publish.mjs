// Fills in the two files npm shows and the one it requires, for every package.
//
//   node scripts/prepare-publish.mjs
//
// Generated rather than committed, because ten hand-maintained READMEs drift the moment
// one of them is edited and the rest are not — and a per-package README whose install
// line is wrong is worse than none. The generated files are gitignored and exist only in
// the tarball; `files` in each manifest lists them.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')

/** What each package is for, in one sentence a reader of the npm page needs. */
const BLURBS = {
  '@aghoz/server':
    'The in-process hub and the HTTP handler, for Express and plain `node:http`. This is ' +
    'the package you mount into your app; everything else is optional.',
  '@aghoz/client':
    'The framework-agnostic browser client, built on `fetch` and `ReadableStream` rather ' +
    'than `EventSource` — because `EventSource` cannot read response headers, and the ' +
    'checkpoint that reports missed updates is a header. Also exports ' +
    '`createSharedClient`, which gives every tab of an origin one connection between them.',
  '@aghoz/react': 'React provider and hooks: `useTopic`, `useTopicReducer`, `useConnectionState`.',
  '@aghoz/react-query':
    'TanStack Query adapter. Maps topics onto query keys so both updates and gaps flow ' +
    'into `invalidateQueries`, which makes adoption a two-line change.',
  '@aghoz/vue': 'Vue 3 composables over a shallow ref: `provideAghoz`, `useTopic`, `useTopicReducer`.',
  '@aghoz/svelte':
    'Svelte stores: `setAghozClient`, `topic`, `topicReducer`. `svelte/store` readables ' +
    'rather than runes, so one package covers Svelte 4 and 5 with no compiler step.',
  '@aghoz/fastify':
    'Fastify adapter. Handles `reply.hijack()` and the raw-request plumbing, without ' +
    'which Fastify serialises and truncates the stream.',
  '@aghoz/nest':
    'NestJS adapter: a DI module plus a handler for a controller you write yourself, so ' +
    'your own `@UseGuards()` still run. Nest\'s `@Sse()` cannot be used — it writes the ' +
    'response itself, which puts the checkpoint header out of reach.',
  '@aghoz/redis':
    'Redis Streams backplane, for more than one process. Redis becomes the id sequencer ' +
    'and the shared history, so a client reconnecting to a different pod is still told ' +
    'truthfully whether it missed anything.',
  '@aghoz/history-file':
    'Disk-backed history, so replay survives a restart. Single-process only — a backplane ' +
    'already is a persistent shared history.',
}

/**
 * Which side of the wire a package runs on.
 *
 * It decides the runtime note, and the distinction is real: the *server* is Node-only,
 * while the client packages run in any browser that has `fetch` and `ReadableStream`.
 * Telling a React developer their UI library is "Node.js only" would be nonsense.
 */
const BROWSER = new Set([
  '@aghoz/client',
  '@aghoz/react',
  '@aghoz/react-query',
  '@aghoz/vue',
  '@aghoz/svelte',
])

const mit = readFileSync(join(ROOT, 'LICENSE-MIT'), 'utf8')
const apache = readFileSync(join(ROOT, 'LICENSE-APACHE'), 'utf8')

let written = 0
for (const dir of readdirSync(PACKAGES)) {
  const path = join(PACKAGES, dir)
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  const blurb = BLURBS[manifest.name]
  if (blurb === undefined) throw new Error(`no blurb for ${manifest.name} — add one here`)

  const peers = Object.keys(manifest.peerDependencies ?? {}).filter((p) => p.startsWith('@aghoz/'))
  const alsoNeeds =
    peers.length === 0 ? '' : `\n\nRequires \`${peers.join('`, `')}\` alongside it.`

  writeFileSync(
    join(path, 'README.md'),
    `# ${manifest.name}

${blurb}${alsoNeeds}

\`\`\`sh
npm install ${manifest.name}
\`\`\`

${
      BROWSER.has(manifest.name)
        ? 'Runs in any browser with `fetch` and `ReadableStream`, and in Node 22+. It talks\nto an aghoz hub, which is **Node.js only** for now — there is no server adapter for\nanother language yet. Cross-origin clients support cookie credentials and dynamic\nheaders that are evaluated again on reconnect; see the integration guide.'
        : '**Node.js only** for now, Node 22+. There is no adapter for another language yet —\nthe Rust core and C ABI exist so that there can be.'
    }

Full documentation, the integration guides and the wire protocol live in the monorepo:
**https://github.com/akosidencio/aghoz**

## License

MIT OR Apache-2.0, at your option.
`,
  )
  writeFileSync(join(path, 'LICENSE-MIT'), mit)
  writeFileSync(join(path, 'LICENSE-APACHE'), apache)
  written++
}

console.log(`prepared ${written} packages — README.md, LICENSE-MIT, LICENSE-APACHE`)
