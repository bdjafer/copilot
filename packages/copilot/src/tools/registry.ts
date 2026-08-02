import type { ToolDefinition, ToolRegistry } from '../types.ts'

// SPEC-copilot §2.4 — the read-only registry exposed as `copilot.tools`, plus the per-run subset
// filter (`TriggerInput.tools`) and the call counters `inspect()` reports.
import { CopilotError } from '../errors.ts'
import { toJsonSchema } from './define.ts'

export interface InternalToolRegistry<
  TTools extends readonly ToolDefinition[],
> extends ToolRegistry<TTools> {
  /** Registered tools filtered by `TriggerInput.tools`; unknown name ⇒ `unknown_tool`. */
  subset(names: readonly string[] | undefined): readonly ToolDefinition[]
  record(name: string, durationMs: number, ok: boolean): void
  stats(): Array<{
    name: string
    description: string
    schema: unknown
    calls: number
    errors: number
    avgMs: number
  }>
}

export function createToolRegistry<const TTools extends readonly ToolDefinition[]>(
  tools: TTools,
): InternalToolRegistry<TTools> {
  const byName = new Map<string, ToolDefinition>()
  const counters = new Map<string, { calls: number; errors: number; totalMs: number }>()

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new CopilotError('duplicate_tool', `duplicate tool name: ${tool.name}`)
    }
    byName.set(tool.name, tool)
    counters.set(tool.name, { calls: 0, errors: 0, totalMs: 0 })
  }

  const schemas = new Map<string, unknown>()
  const schemaFor = (name: string): unknown => {
    if (!schemas.has(name)) {
      const tool = byName.get(name)
      schemas.set(name, tool === undefined ? undefined : toJsonSchema(tool.inputSchema))
    }
    return schemas.get(name)
  }

  return {
    names: tools.map((tool) => tool.name) as readonly TTools[number]['name'][],
    get(name) {
      return (byName.get(name) ?? null) as never
    },
    has(name) {
      return byName.has(name)
    },
    schema(name) {
      return schemaFor(name)
    },
    subset(names) {
      if (names === undefined) return [...byName.values()]
      return names.map((name) => {
        const tool = byName.get(name)
        if (tool === undefined) {
          throw new CopilotError('unknown_tool', `unknown tool: ${name}`, { toolName: name })
        }
        return tool
      })
    },
    record(name, durationMs, ok) {
      const counter = counters.get(name)
      if (counter === undefined) return
      counter.calls += 1
      counter.totalMs += durationMs
      if (!ok) counter.errors += 1
    },
    stats() {
      return [...byName.values()].map((tool) => {
        const counter = counters.get(tool.name) ?? { calls: 0, errors: 0, totalMs: 0 }
        return {
          name: tool.name,
          description: tool.description,
          schema: schemaFor(tool.name),
          calls: counter.calls,
          errors: counter.errors,
          avgMs: counter.calls === 0 ? 0 : counter.totalMs / counter.calls,
        }
      })
    },
  }
}
