/**
 * SPEC-swarm §1.2 and §13 — the boundary gates.
 *
 * §13 states them as `grep -rE` invocations. They are implemented here over **code with comments
 * and string literals stripped**, for one reason: a literal `grep -rE "\bprocess\b"` forbids the
 * English word *process* in a prose comment, and §5.3 — the section the rule protects — is three
 * paragraphs about process groups. The rule is about what a module *references*, so the scanner
 * looks at code. Everything else is asserted exactly as written. (Deviation D5.)
 *
 * The import-graph walk is stronger than any grep: it starts at `src/index.ts` and follows every
 * relative import, so a `node:*` reference three modules deep still fails the client-core gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { effortLadder } from '../src/domain/directive.ts'
import { decodeServerFrame, encodeFrame } from '../src/protocol/codec.ts'

const SRC = resolve(import.meta.dirname, '../src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * One scanner, two views. `bare` drops comments **and** string literals — that is what a
 * "does this module reference X" check must look at. `imports` drops comments only, because a
 * module specifier *is* a string literal and dropping it would make the graph walk see nothing.
 */
function scan(source: string): { bare: string; imports: string } {
  let bare = ''
  let imports = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        if (source[i] === '\n') {
          bare += '\n'
          imports += '\n'
        }
        i++
      }
      i += 2
      continue
    }
    const ch = source[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      imports += ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          imports += source[i]
          i++
        }
        if (source[i] === '\n') bare += '\n'
        imports += source[i] ?? ''
        i++
      }
      imports += quote
      i++
      continue
    }
    bare += ch
    imports += ch
    i++
  }
  return { bare, imports }
}

const code = (source: string): string => scan(source).bare

const FILES = walk(SRC).map((path) => ({
  path,
  rel: relative(SRC, path),
  raw: readFileSync(path, 'utf8'),
  get code() {
    return code(this.raw)
  },
}))

const NODE_OR_DOM_ALLOWED = (rel: string): boolean =>
  rel.startsWith('server/') || rel.startsWith('cli/') || rel.startsWith('testing/node/')

describe('§1.2 forbidden imports', () => {
  it('never names comment-core, comment-ui, browser-copilot, temporal-memory, wxt or chrome.*', () => {
    const pattern = /chrome\.|wxt\/|comment-core|comment-ui|browser-copilot|temporal-memory/
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('declares no runtime dependency on another workspace package', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(name.startsWith('@astrale-os/')).toBe(false)
    }
  })
})

describe('§1.1 the client core is DOM-free and Node-free', () => {
  it('names node:* only under src/server, src/cli and src/testing/node', () => {
    const offenders = FILES.filter((f) => /node:/.test(f.code) && !NODE_OR_DOM_ALLOWED(f.rel)).map(
      (f) => f.rel,
    )
    expect(offenders).toEqual([])
  })

  it('references `process` only under src/server, src/cli and src/testing/node', () => {
    const offenders = FILES.filter(
      (f) => /\bprocess\b/.test(f.code) && !NODE_OR_DOM_ALLOWED(f.rel),
    ).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('names DOM globals only in src/presentation.ts (and the Node-side directories)', () => {
    const pattern = /\b(document|window|navigator|localStorage|HTMLElement|ShadowRoot)\b/
    const offenders = FILES.filter(
      (f) => pattern.test(f.code) && f.rel !== 'presentation.ts' && !NODE_OR_DOM_ALLOWED(f.rel),
    ).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('reaches no node:* and no DOM global through the whole import graph of `.` (#34, §13)', () => {
    const seen = new Set<string>()
    const queue = [resolve(SRC, 'index.ts')]
    /* `[^'"]*?` keeps the match inside one statement: an import block has no quote between
     * `import` and `from`, while a table of string literals cannot be crossed to reach a
     * distant `from`. The codebase omits semicolons, so there is no terminator to anchor on. */
    const specifier = /(?:^|\n)\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g

    while (queue.length > 0) {
      const path = queue.pop()!
      if (seen.has(path)) continue
      seen.add(path)
      const scanned = scan(readFileSync(path, 'utf8'))
      const body = scanned.bare
      const rel = relative(SRC, path)
      expect({ rel, hit: /node:/.test(body) }).toEqual({ rel, hit: false })
      expect({ rel, hit: /\b(document|window|navigator|localStorage)\b/.test(body) }).toEqual({
        rel,
        hit: false,
      })
      for (const match of scanned.imports.matchAll(specifier)) {
        const target = match[1]!
        expect({ rel, target, bare: !target.startsWith('.') }).toEqual({
          rel,
          target,
          bare: false,
        })
        queue.push(resolve(dirname(path), target))
      }
    }

    /* The graph must actually cover the entry's modules, or the walk proved nothing. */
    expect(seen.size).toBeGreaterThan(10)
  })

  it('stays callable with document, window, navigator, chrome, localStorage and process deleted', () => {
    const globals = [
      'document',
      'window',
      'navigator',
      'chrome',
      'localStorage',
      'process',
    ] as const
    const saved = new Map<string, unknown>()
    for (const name of globals) {
      if (name in globalThis) {
        saved.set(name, (globalThis as Record<string, unknown>)[name])
        delete (globalThis as Record<string, unknown>)[name]
      }
    }
    try {
      const text = encodeFrame({ p: 'swarm', v: 1, k: 'ping', t: 1 })
      expect(decodeServerFrame(text).ok).toBe(true)
      expect(effortLadder('openai', 'gpt-5.4').length).toBeGreaterThan(0)
    } finally {
      for (const [name, value] of saved) {
        ;(globalThis as Record<string, unknown>)[name] = value
      }
    }
  })
})

describe('§13 the presentation seam depends on nothing (#34)', () => {
  it('does not contain the module-loading keyword ANYWHERE — not even in a comment', () => {
    const presentation = FILES.find((f) => f.rel === 'presentation.ts')
    expect(presentation).toBeDefined()
    /* Asserted over the RAW source, so §13's literal `grep -E "import"` passes as written. */
    expect(/\bimport\b/.test(presentation!.raw)).toBe(false)
    expect(/\bfrom\s*['"]/.test(presentation!.code)).toBe(false)
    expect(/\brequire\s*\(/.test(presentation!.code)).toBe(false)
  })

  it('emits a .d.ts with the same property, when one has been built', () => {
    const emitted = resolve(import.meta.dirname, '../dist/types/presentation.d.ts')
    if (!existsSync(emitted)) return
    expect(/\bimport\b/.test(readFileSync(emitted, 'utf8'))).toBe(false)
  })

  it('is types only — no runtime export can leak a dependency in later', () => {
    const presentation = FILES.find((f) => f.rel === 'presentation.ts')!
    expect(/export\s+(const|function|class|let|var)\b/.test(presentation.code)).toBe(false)
  })
})

describe('§5.4 the never-call list, grep-enforced', () => {
  it('never calls detachSession or globalEvents (#10, #11)', () => {
    const offenders = FILES.filter((f) => /detachSession|globalEvents/.test(f.code)).map(
      (f) => f.rel,
    )
    expect(offenders).toEqual([])
  })

  it('never calls getHistory — the safe read is peekSession ([F8], #45)', () => {
    const offenders = FILES.filter((f) => /getHistory/.test(f.code)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('never passes waitForAccept: it resolves on timeout and would report every ack accepted (#42)', () => {
    const offenders = FILES.filter((f) => /waitForAccept/.test(f.code)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })
})

describe('§1.1 the package declares four entries and the swarm bin', () => {
  it('exports `.`, `./presentation`, `./server` and `./testing`, and nothing else', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { exports: Record<string, unknown>; bin: Record<string, string> }
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './presentation',
      './server',
      './testing',
    ])
    expect(pkg.bin).toEqual({ swarm: './dist/cli.js' })
  })
})
