// SPEC-copilot §4 — id generation with an injectable seam (`CopilotOptions.createId`).
import { nanoid } from 'nanoid'

/** Default run id factory: `nanoid(12)` (§2.5). */
export const createRunId = (): string => nanoid(12)

/** Stable id of the emitting runtime instance: `nanoid(8)` at construction (§2.8). */
export const createInstanceId = (): string => nanoid(8)
