/**
 * `comment-core/headless` — the DOM-free entry point (§1.1).
 *
 * **Normative, not a convenience.** The root entry's *type* surface references `Element`,
 * `Range`, `Document`, `ParentNode` and `Selection`, so under a service-worker tsconfig
 * (`lib: ["ES2022", "WebWorker"]`) `import … from 'comment-core'` does not compile — those
 * identifiers do not exist. A service worker imports from here instead, and nothing reachable
 * from this file may reference a `lib.dom` identifier or touch `document`, `window`,
 * `navigator`, `chrome` or `localStorage` at module scope.
 */

/* --- domain (§2.9) --- */
export { createDomain } from './domain/index.ts'

/* --- store port + shipped adapters (§2.7, §2.8) --- */
export { defineCommentStore } from './store/common.ts'
export { createMemoryStore, type MemoryStore } from './store/memory.ts'
export { createKeyValueStore } from './store/kv.ts'
export { createLocalStorageStore, type StorageLike } from './store/local-storage.ts'

/* --- store-level observation (§2.10) --- */
export { createKeyValueCursor, observeStore } from './observe.ts'

/* --- page key (§2.6) --- */
export { createPageKey, defaultPageKey, volatileParams } from './page-key.ts'

/* --- errors (§2.14) --- */
export { CommentError, type CommentErrorCode } from './errors.ts'

/* --- DOM-free types (§2.1 – §2.13) --- */
export { THREAD_VERSION } from './types.ts'
export type {
  AnchorDescriptor,
  AnchorStatus,
  AppendCommentInput,
  AppendResult,
  Author,
  BuiltinSelector,
  Comment,
  CommentDomain,
  CommentRef,
  CommentStore,
  CreateResult,
  CreateThreadInput,
  CustomSelector,
  DeleteCommentResult,
  DocumentRect,
  DomainOptions,
  ElementCapture,
  ElementFingerprint,
  ErrorPhase,
  EventSource,
  KeyValueAdapter,
  MatchVia,
  ObserveCursor,
  ObserveOptions,
  PageKeyFn,
  PageKeyOptions,
  ReadableStore,
  Selector,
  StoredThread,
  StoreEvent,
  StoreEventMap,
  StoreEventName,
  Thread,
  ThreadFilter,
  ThreadRecord,
  Unsubscribe,
  WriteResult,
} from './types.ts'
