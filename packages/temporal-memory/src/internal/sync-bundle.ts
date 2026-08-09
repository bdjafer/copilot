import type { JsonValue, SyncBundleFrame, SyncCheckpoint } from '../types.ts'

import { sha256, stableStringify } from './value.ts'

export const SYNC_BUNDLE_MEDIA_TYPE =
  'application/vnd.astrale.temporal-memory-sync-bundle+json' as const
export const SYNC_BUNDLE_VERSION = 1 as const
export const SYNC_BUNDLE_CHECKPOINT_DIGEST_DOMAIN =
  'astrale.temporal-memory/sync-bundle-checkpoint-digest/v1'
export const DEFAULT_SYNC_BUNDLE_CHECKPOINTS = 10_000
export const MAX_SYNC_BUNDLE_CHECKPOINTS = 100_000
export const DEFAULT_SYNC_BUNDLE_CHECKPOINT_BYTES = 64 * 1024 * 1024
export const MAX_SYNC_BUNDLE_CHECKPOINT_BYTES = 1024 * 1024 * 1024
export const DEFAULT_SYNC_BUNDLE_FRAMES = 16
export const MAX_SYNC_BUNDLE_FRAMES = 64
export const DEFAULT_SYNC_BUNDLE_PAGE_BYTES = 32 * 1024 * 1024
export const MAX_SYNC_BUNDLE_PAGE_BYTES = 256 * 1024 * 1024

export function syncBundleFrameByteLength(frame: SyncBundleFrame): number {
  return new TextEncoder().encode(stableStringify(frame as unknown as JsonValue)).byteLength
}

export async function emptySyncBundleCheckpointDigest(
  spaceId: string,
  checkpointId: string,
): Promise<string> {
  return sha256(
    stableStringify([
      SYNC_BUNDLE_CHECKPOINT_DIGEST_DOMAIN,
      SYNC_BUNDLE_VERSION,
      spaceId,
      checkpointId,
    ]),
  )
}

export async function appendSyncBundleCheckpointDigest(
  root: string,
  index: number,
  checkpoint: SyncCheckpoint,
): Promise<string> {
  return sha256(
    stableStringify([
      SYNC_BUNDLE_CHECKPOINT_DIGEST_DOMAIN,
      root,
      index,
      await sha256(stableStringify(checkpoint as unknown as JsonValue)),
    ]),
  )
}
