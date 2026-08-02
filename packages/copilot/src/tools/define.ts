// SPEC-copilot §2.4 — `defineTool`, `toolsFor`, and JSON-Schema derivation for `inspect()` and
// for the provider. `const TName` + Standard Schema inference is what makes `ToolCall<TTools>` a
// discriminated union keyed on literal tool names.
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { asSchema } from 'ai'

import type { Awaitable, ToolContext, ToolDefinition, ToolTransport } from '../types.ts'

import { remoteTool } from './remote.ts'

export interface ToolDefinitionInput<
  TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput,
  TContext,
> {
  name: TName
  description: string
  inputSchema: TSchema
  outputSchema?: StandardSchemaV1<unknown, TOutput>
  execute(
    input: StandardSchemaV1.InferOutput<TSchema>,
    ctx: ToolContext<TContext>,
  ): Awaitable<TOutput>
  timeoutMs?: number
}

/** Author a tool. Identity at runtime; everything it does happens in the type system. */
export function defineTool<
  const TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput,
  TContext = unknown,
>(
  def: ToolDefinitionInput<TName, TSchema, TOutput, TContext>,
): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, Awaited<TOutput>, TContext> {
  return def as unknown as ToolDefinition<
    TName,
    StandardSchemaV1.InferOutput<TSchema>,
    Awaited<TOutput>,
    TContext
  >
}

export interface RemoteToolInput<TName extends string, TSchema extends StandardSchemaV1, TOutput> {
  name: TName
  description: string
  inputSchema: TSchema
  outputSchema?: StandardSchemaV1<unknown, TOutput>
  timeoutMs?: number
}

/**
 * Bind `defineTool` / `remoteTool` to a context type. `defineTool`'s `TContext` is a trailing
 * type parameter with no inference site, so `ctx.context` is `unknown` in every tool written the
 * plain way; one line restores it.
 */
export function toolsFor<TContext>(): {
  defineTool<const TName extends string, TSchema extends StandardSchemaV1, TOutput>(
    def: ToolDefinitionInput<TName, TSchema, TOutput, TContext>,
  ): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, Awaited<TOutput>, TContext>
  remoteTool<const TName extends string, TSchema extends StandardSchemaV1, TOutput = unknown>(
    def: RemoteToolInput<TName, TSchema, TOutput>,
    transport: ToolTransport<TContext>,
  ): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TContext>
} {
  return { defineTool: defineTool as never, remoteTool: remoteTool as never }
}

const FALLBACK_SCHEMA = { type: 'object', properties: {}, additionalProperties: true } as const

/**
 * JSON Schema for a Standard Schema. zod v4 and any vendor exposing `~standard.jsonSchema`
 * convert; anything else degrades to a permissive object rather than failing tool registration.
 */
export function toJsonSchema(schema: StandardSchemaV1<unknown, unknown>): unknown {
  try {
    const derived = asSchema(schema as never).jsonSchema
    // A vendor may hand back a promise; `ToolRegistry.schema()` is synchronous by contract.
    return typeof (derived as { then?: unknown } | undefined)?.then === 'function'
      ? FALLBACK_SCHEMA
      : derived
  } catch {
    return FALLBACK_SCHEMA
  }
}

/** Standard Schema validation, normalised to a plain result. */
export async function validateWithSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const result = await schema['~standard'].validate(value)
  if (result.issues === undefined) return { ok: true, value: result.value }
  const message = result.issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.')
      return path !== undefined && path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
  return { ok: false, message }
}
