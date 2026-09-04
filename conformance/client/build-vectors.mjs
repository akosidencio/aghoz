// Emits conformance/client/vectors.json.
//
// The subscriber half of the protocol. `../vectors.json` covers a client only by
// accident — the encode vectors run in reverse, id comparison applies directly — and
// nothing there pins §9, which is where every rule a *client* can get wrong lives.
//
// This file starts that corpus with the rule the wire format cannot express: §9.3's
// topic-set cutover, which is a fact about the client's own history and invisible to
// the server. Every expected value is written out from PROTOCOL.md by hand; a corpus
// captured from `@aghoz/client` would only prove `@aghoz/client` agrees with itself.
//
//   node build-vectors.mjs

import { writeFileSync } from 'node:fs'

const vectors = {
  // Bumped whenever a vector's expected value changes or a group is added, so a client
  // implementation can report which corpus it passes. 0.1 is the first: §9.3 cutover.
  version: '0.1',
  spec: 'PROTOCOL.md',
  note:
    'Each vector drives a client\'s coverage state through `ops` and compares the topics ' +
    'reported at every `open`. `initialCursor` is the §5 cursor the client was ' +
    'constructed with, or null. Ops: ["sync", topics] — the client is about to open for ' +
    'this set; ["open", topics] — the stream for this set is open, and the vector\'s ' +
    'next expected entry is what it must report; ["advance", id] — a data frame the ' +
    'client accepted moved the cursor.',

  // ---- §9.3 topic-set cutover ---------------------------------------------
  //
  // A cursor names a position in one sequence, and a topic is covered by it only over
  // the range the topic was in the open set. K3 is the interleaving §9.3 describes in
  // prose and the reason this group exists; everything else here bounds it, because a
  // rule that fires too often teaches applications to ignore it and a rule that fires
  // too rarely is silent staleness.
  cutover: [
    {
      id: 'K1', ref: '§9.3', desc: 'the first open of a page-load topic set reports nothing',
      initialCursor: '1755083412345-0',
      ops: [['sync', ['a']], ['open', ['a']]],
      expected: [[]],
    },
    {
      id: 'K2', ref: '§9.3',
      desc: 'a topic added before anything arrived shares the page\'s baseline and is not a cutover',
      initialCursor: '1755083412345-0',
      ops: [['sync', ['a']], ['open', ['a']], ['sync', ['a', 'b']], ['open', ['a', 'b']]],
      expected: [[], []],
    },
    {
      id: 'K3', ref: '§9.3',
      desc: 'the §9.3 interleaving: a topic added after the cursor moved has no baseline',
      // b's id 11 was assigned while the connection carried only a, and a's id 12 then
      // advanced the cursor past it. Reconnecting for a,b from 12 cannot replay 11, and
      // no history was truncated — the hub is right that nothing was lost, and b is
      // still missing an event. This is the vector the whole group exists for.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
      ],
      expected: [[], ['b']],
    },
    {
      id: 'K4', ref: '§9.3',
      desc: 'a client with no initial cursor and no events reports no cutover',
      // There is no baseline anywhere to be inconsistent with. The window between a
      // page\'s data and its stream is §5\'s failure and has §5\'s fix; reporting it here
      // as well would fire on every first load and teach applications to ignore this.
      initialCursor: null,
      ops: [['sync', ['a']], ['open', ['a']], ['sync', ['a', 'b']], ['open', ['a', 'b']]],
      expected: [[], []],
    },
    {
      id: 'K5', ref: '§9.3',
      desc: 'a topic dropped and re-added while the cursor stood still is still covered',
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
        ['sync', ['a']], ['open', ['a']],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
      ],
      expected: [[], [], []],
    },
    {
      id: 'K6', ref: '§9.3',
      desc: 'a topic dropped, then re-added after the cursor moved, is a cutover',
      // The events for b between the two connections are exactly the ones the cursor
      // cannot vouch for, and a client that treated "I had this topic once" as coverage
      // would deliver a projection missing every one of them.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
      ],
      expected: [[], [], ['b']],
    },
    {
      id: 'K7', ref: '§9.3 / §9.4',
      desc: 'reconnecting the same topic set after events is not a cutover',
      // The reconnect resumes from a cursor that covers every topic in the set, which is
      // the ordinary replay contract. Firing here would mean a refetch on every dropped
      // connection, which is the polling this library replaces.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['open', ['a']],
      ],
      expected: [[], []],
    },
    {
      id: 'K8', ref: '§9.3', desc: 'a cutover is reported once, not on every later open',
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
        ['open', ['a', 'b']],
      ],
      expected: [[], ['b'], []],
    },
    {
      id: 'K9', ref: '§9.3 / §9.4',
      desc: 'a connection attempt that never opened does not consume the cutover',
      // §9.4 backs off through failures. A cutover recorded at the topic change and
      // discarded on a failed attempt would leave the topic permanently uncovered with
      // nothing reported — the failure mode is silent, which makes it the expensive one.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']],
        ['sync', ['a', 'b']],
        ['open', ['a', 'b']],
      ],
      expected: [[], ['b']],
    },
    {
      id: 'K10', ref: '§9.3',
      desc: 'a topic added and dropped before any stream opened is not reported later',
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']],
        ['sync', ['a']], ['open', ['a']],
      ],
      expected: [[], []],
    },
    {
      id: 'K11', ref: '§9.3', desc: 'several topics added at once are reported together, sorted',
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b', 'c']], ['open', ['a', 'b', 'c']],
      ],
      expected: [[], ['b', 'c']],
    },
    {
      id: 'K12', ref: '§9.3',
      desc: 'an established topic is never reported alongside the new one',
      // Reporting the whole set would be safe and useless: every cutover would invalidate
      // every query on the connection, so the signal would cost more than the polling.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a']], ['open', ['a']],
        ['advance', '1755083412345-12'],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
        ['advance', '1755083412345-13'],
        ['sync', ['a', 'b', 'c']], ['open', ['a', 'b', 'c']],
      ],
      expected: [[], ['b'], ['c']],
    },
    {
      id: 'K13', ref: '§9.3',
      desc: 'every topic going away and coming back after events is a cutover for all of them',
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
        ['advance', '1755083412345-12'],
        ['sync', []],
        ['advance', '1755083412345-13'],
        ['sync', ['a', 'b']], ['open', ['a', 'b']],
      ],
      expected: [[], ['a', 'b']],
    },
    {
      id: 'K14', ref: '§9.3',
      desc: 'the cursor moving while the set is empty leaves the next open uncovered',
      // An idle client — every component unmounted — still holds a cursor, and a shared
      // connection in another tab keeps moving it. Treating "nothing was subscribed, so
      // nothing was missed" as coverage is how a route change loses an event.
      initialCursor: '1755083412345-0',
      ops: [
        ['sync', []],
        ['advance', '1755083412345-12'],
        ['sync', ['a']], ['open', ['a']],
      ],
      expected: [['a']],
    },
  ],
}

writeFileSync(new URL('./vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`)
console.log(
  `client corpus: ${Object.values(vectors).filter(Array.isArray).flat().length} vectors`,
)
