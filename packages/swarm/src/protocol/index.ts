/**
 * `swarm.v1` — re-exported **whole** from `.` (§1.1) and imported by `./server` through a
 * relative path, never through the client barrel. It is types plus a pure codec with zero
 * dependencies, so a Node-only consumer pays nothing at runtime for it.
 */

export {
  SWARM_PROTOCOL,
  SWARM_PROTOCOL_VERSION,
  SWARM_SUBPROTOCOL,
  SWARM_TOKEN_SUBPROTOCOL_PREFIX,
  SERVER_CAPABILITIES,
  STREAM_FAMILIES,
  INTENT_NAMES,
  CLIENT_FRAME_KINDS,
  SERVER_FRAME_KINDS,
} from './frames.ts'
export type {
  AckFrame,
  ByeFrame,
  ClientFrame,
  ClientFrameKind,
  ClientPingFrame,
  Envelope,
  ErrFrame,
  EvtFrame,
  HeadKind,
  HelloFrame,
  HelloOkFrame,
  IntentName,
  LaggedFrame,
  LagReason,
  ReqFrame,
  ResFrame,
  ServerCapability,
  ServerFrame,
  ServerFrameKind,
  ServerPingFrame,
  SnapFrame,
  StreamFamily,
  StreamName,
  SubFrame,
  UnsubFrame,
} from './frames.ts'

export {
  BACKPRESSURE,
  CLOSE_CODES,
  DEGRADABLE_STREAM_FAMILIES,
  HEARTBEAT,
  LAG_REASONS,
  LIMITS,
  RECONNECT,
  RESUBSCRIBE_ORDER,
  RETENTION,
  TERMINAL_CLOSE_CODES,
  backoffDelayMs,
  blockedReasonForCloseCode,
  isDegradableStream,
  isTerminalCloseCode,
} from './constants.ts'
export type { CloseCode, CloseCodeName } from './constants.ts'

export {
  EVENT_PROJECTION,
  EVENT_STREAM_FAMILY,
  SWARM_EVENT_KINDS,
  TRANSPORT_ONLY_CLIENT_EVENTS,
  isSwarmEventKind,
  streamFamilyOf,
} from './events.ts'
export type { SwarmEvent, SwarmEventKind } from './events.ts'

export {
  attemptStream,
  base64DecodedBytes,
  decodeClientFrame,
  decodeServerFrame,
  delegationStream,
  encodeFrame,
  exceedsFrameLimit,
  isHelloFrame,
  parseStreamName,
  resolveSubscription,
  utf8ByteLength,
} from './codec.ts'
export type { DecodeFailure, DecodeResult, ParsedStream, SubscriptionPlan } from './codec.ts'

export { decodeIntentResponse } from './intents.ts'
export type { IntentArgs, IntentResponse } from './intents.ts'

export { decodeSnapshot } from './snapshots.ts'
export type {
  AttemptSnapshot,
  DelegationSnapshot,
  FleetSnapshot,
  ServerSnapshot,
  SnapshotByFamily,
} from './snapshots.ts'
