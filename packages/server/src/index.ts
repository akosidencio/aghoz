/**
 * @aghoz/server
 *
 * Server push that mounts into an application you already have. The hub is an object
 * in your process, so your existing authentication middleware runs before it and
 * authorization is a function of the request you already parsed.
 *
 * `createHub` is the entry point; the protocol primitives below it are exported for
 * adapters and tests.
 *
 * Zero runtime dependencies, by design — see DECISIONS.md D2. The protocol core
 * (`hub.ts`, `registry.ts`) performs no IO at all; only `create-hub.ts` touches sockets,
 * which is what keeps the corpus able to own the parts that must never diverge.
 */

export {
  Hub,
  type HubOptions,
  type EventId,
  formatId,
  parseId,
  compareIds,
  validTopic,
  validOrigin,
  utf8Length,
  encodeFrame,
  encodeControl,
} from './hub.js'

export { Registry, type RegistryOptions, type AddResult } from './registry.js'

export {
  type HubCore,
  type CoreConfig,
  type CheckpointKind,
  type BufferKind,
  CoreError,
} from './core.js'

export type {
  Backplane,
  BackplaneEvent,
  BackplaneReplay,
} from './backplane.js'

export {
  createMemoryStore,
  type HistoryStore,
  type LoadedHistory,
  type StoredEvent,
} from './history.js'

export { createTsCore } from './core-ts.js'
export { createNativeCore, type NativeModule } from './core-native.js'

export {
  createHub,
  type CreateHubOptions,
  type HandlerOptions,
  type PublishOptions,
  type PublishAck,
} from './create-hub.js'

export type { HubStats, CloseReason, RejectReason } from './stats.js'
