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

import { createSwarmClient } from '../src/client/index.ts'
import { effortLadder } from '../src/domain/directive.ts'
import { decodeServerFrame, encodeFrame } from '../src/protocol/codec.ts'
import { createFakeTransport } from '../src/testing/fake-transport.ts'

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

/**
 * Every module specifier a file can reach another module through, in one place.
 *
 * The graph walk is only as strong as this function: a form it does not recognise is a hole a
 * Node-touching module can be pulled through without failing the gate. Three forms exist —
 * `import … from 'x'` / `export … from 'x'`, the **side-effect** `import 'x'` (no `from` to
 * anchor on), and the **dynamic** `import('x')` — and all three are matched.
 */
export function specifiersOf(imports: string): string[] {
  const patterns = [
    /* `[^'"]*?` keeps the match inside one statement: an import block has no quote between
     * `import` and `from`, while a table of string literals cannot be crossed to reach a
     * distant `from`. The codebase omits semicolons, so there is no terminator to anchor on. */
    /(?:^|\n)\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  const out: string[] = []
  for (const pattern of patterns) {
    for (const match of imports.matchAll(pattern)) out.push(match[1]!)
  }
  return out
}

/** The globals no module reachable from `.` may name, per §1.2 and §13. */
const FORBIDDEN_IN_GRAPH: readonly (readonly [string, RegExp])[] = [
  ['node:', /node:/],
  ['a DOM global', /\b(document|window|navigator|localStorage|HTMLElement|ShadowRoot)\b/],
  ['an extension or bundler global', /chrome\.|wxt\//],
]

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

    while (queue.length > 0) {
      const path = queue.pop()!
      if (seen.has(path)) continue
      seen.add(path)
      const scanned = scan(readFileSync(path, 'utf8'))
      const body = scanned.bare
      const rel = relative(SRC, path)
      for (const [label, pattern] of FORBIDDEN_IN_GRAPH) {
        expect({ rel, label, hit: pattern.test(body) }).toEqual({ rel, label, hit: false })
      }
      for (const target of specifiersOf(scanned.imports)) {
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

  it('the walk sees side-effect and dynamic imports, not only `from` clauses', () => {
    /* Without this, a client module could pull a Node-touching one in through either form and
     * the graph gate would report a clean walk over a graph it never entered. */
    const source = [
      "import { a } from './a.ts'",
      "export { b } from './b.ts'",
      "import './side-effect.ts'",
      "const c = await import('./dynamic.ts')",
      "const d = require('./legacy.ts')",
      "const notAnImport = ['./table-entry.ts', 'from']",
    ].join('\n')
    expect(specifiersOf(scan(source).imports).sort()).toEqual([
      './a.ts',
      './b.ts',
      './dynamic.ts',
      './legacy.ts',
      './side-effect.ts',
    ])
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
      /* §13 names `createSwarmClient` in the same breath as the three pure functions, and it is
       * the only one of the four that constructs anything: it wires a connection, four stores, a
       * queue and a tick. A `document`, a `WebSocket` or a `process.nextTick` reached during that
       * construction is exactly what this deletion is meant to catch. */
      const client = createSwarmClient({
        transport: createFakeTransport(),
        clientName: 'boundaries/0.1',
        head: 'test',
        now: () => 1,
      })
      expect(client.connection.get().status).toBe('connecting')
      expect(client.inspect().protocolVersion).toBe(1)
      client.destroy()
    } finally {
      for (const [name, value] of saved) {
        ;(globalThis as Record<string, unknown>)[name] = value
      }
    }
  })
})

describe('§13 the compile-time half of the boundary (the one deletion cannot prove)', () => {
  it('ships a fixture project with lib:["ES2022"], no dom and no @types/node', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../tsconfig.es2022.json'), 'utf8'),
    ) as {
      compilerOptions: { lib: string[]; types: string[] }
      include: string[]
    }
    expect(config.compilerOptions.lib).toEqual(['ES2022'])
    expect(config.compilerOptions.types).toEqual([])
    expect(config.include).toEqual(['test/fixtures/es2022-client.ts'])
    /* The fixture must reach the `.` entry, or the project proves nothing about it. */
    const fixture = readFileSync(resolve(import.meta.dirname, 'fixtures/es2022-client.ts'), 'utf8')
    expect(fixture).toContain("from '../../src/index.ts'")
    expect(fixture).toContain('createSwarmClient')
  })

  it('runs that project as part of `pnpm typecheck`, so a DOM leak fails the gate', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck).toContain('tsconfig.es2022.json')
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

describe('§13 the greps are runnable — the source has to be text', () => {
  it('every source file is line-oriented text, so `grep -n` reports lines and not "Binary file"', () => {
    /* Anything outside tab/newline/carriage-return trips the heuristic. A composite map key
     * written with a literal NUL instead of the `\u0000` escape is the way it happens. */
    const isControl = (code: number): boolean =>
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f
    const offenders = FILES.filter((f) => {
      for (let i = 0; i < f.raw.length; i++) if (isControl(f.raw.charCodeAt(i))) return true
      return false
    }).map((f) => f.rel)
    expect(offenders).toEqual([])
  })
})

describe('§5.4 the never-call list, grep-enforced', () => {
  it('prose only: every raw hit for a forbidden name is inside a comment, in every file', () => {
    /*
     * The comment-stripped greps above prove no module *references* these. This proves the
     * stripping is the only reason they pass — i.e. that each raw hit is documentation and not a
     * string literal, an identifier in a template, or a dynamic property access. Without it,
     * "implemented over code" is an unchecked claim about the scanner rather than about the code.
     */
    const forbidden = [
      /detachSession/,
      /globalEvents/,
      /comment-core|comment-ui|browser-copilot|temporal-memory/,
      /chrome\.|wxt\//,
    ]
    const inCode: string[] = []
    let proseHits = 0
    for (const file of FILES) {
      for (const pattern of forbidden) {
        if (pattern.test(file.raw)) proseHits += 1
        if (pattern.test(file.code)) inCode.push(`${file.rel} :: ${pattern.source}`)
      }
    }
    expect(inCode).toEqual([])
    /* And the check is not vacuous: these names ARE discussed, which is the whole deviation. */
    expect(proseHits).toBeGreaterThan(5)
  })

  it('never calls detachSession or globalEvents (#10, #11)', () => {
    const offenders = FILES.filter((f) => /detachSession|globalEvents/.test(f.code)).map(
      (f) => f.rel,
    )
    expect(offenders).toEqual([])
  })

  /**
   * §5.4 banned `getHistory` outright ([F8], #45): it does `content.as_str().unwrap_or("")`, so a
   * block-array message reads as `''`, and a digest match against `''` makes every `unknown` turn
   * look un-landed — the one direction Q5 says must never auto-act.
   *
   * That hazard is unchanged. What changed is the alternative: verified against jcode 0.67.0,
   * `peek_session` is the *stored* tail and never carries what swarm sends (a `noReply` message
   * was still absent after 3 s while `get_history` already had it). `peekSession` alone would
   * match the digest against a transcript the prompt is never in — failing closed on every turn,
   * which is not the safe direction, just a different wrong one.
   *
   * So the ban becomes a pairing rule: `getHistory` may be called, but never alone. Recorded as an
   * amendment in SPEC §5.2, §5.4 #12, §12 #13/#45 and §13 — the gate and the locked contract now
   * say the same thing, which is the whole point of a locked contract.
   *
   * **File scope is not enough.** The first version of this asserted `/getHistory/ && /peekSession/`
   * per file, which `sdk-transport.ts` satisfied merely because the *word* `peekSession` appears in
   * a neighbouring method — a pass that carries no information about the call that matters. The
   * rule is about a **read**, so it is asserted at the two places a read can exist: the transport
   * pass-throughs, which are declarations rather than reads, are enumerated by name; and the one
   * real consumer must pair the two calls **inside the same function body**.
   */
  it('reads getHistory in exactly one place, and never without peekSession in the same function', () => {
    /* `sdk.ts` declares the port, `sdk-transport.ts` forwards it and `fake-jcode.ts` implements it
     * for the tests: a method that exists is not a read. Enumerated rather than pattern-matched, so
     * a third forwarder has to be argued for. */
    const DECLARERS = [
      'server/executor/sdk.ts',
      'server/executor/sdk-transport.ts',
      'testing/node/fake-jcode.ts',
    ]
    const mentions = FILES.filter((f) => /getHistory/.test(f.code)).map((f) => f.rel)
    expect(mentions.filter((rel) => !DECLARERS.includes(rel))).toEqual(['server/executor/jcode.ts'])

    /* The consumer: `tail()` must call both, and the pairing is asserted over the function body,
     * not the file. A `getHistory` added to any other method of the same class fails here. */
    const jcode = FILES.find((f) => f.rel === 'server/executor/jcode.ts')!
    const bodies = jcode.code.split(/\n\s*(?:async\s+)?[a-zA-Z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/)
    const paired = bodies.filter((body) => /getHistory/.test(body) && /peekSession/.test(body))
    const lonely = bodies.filter((body) => /getHistory/.test(body) && !/peekSession/.test(body))
    expect(lonely).toEqual([])
    expect(paired).toHaveLength(1)
  })

  /**
   * §13 required `waitForAccept` to be ABSENT, on `@1jehuang/jcode-sdk@1.0.1`'s default of "do
   * not wait". The installed 1.1.0 reads `options.waitForAccept ?? true` with
   * `acceptTimeoutMs ?? 10_000`, so absence now means up to ten seconds of blocking on exactly
   * the un-acked send — and the SDK's `waitForEvent` still *resolves* on timeout, so the wait
   * cannot even tell `accepted` from `unknown` ([F2]). The rule that survives the version bump is
   * the one that always mattered: never `true`.
   */
  it('never passes waitForAccept: true — the ack comes from the stream, never the call (#42)', () => {
    const offenders = FILES.filter((f) => /waitForAccept\s*:\s*true/.test(f.code)).map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('and the only places that PASS one are the two executor files', () => {
    /* `waitForAccept?:` (the port's own declaration) and the name quoted inside a message string
     * are not call sites; `waitForAccept:` followed by a value is. */
    const sites = FILES.filter((f) => /waitForAccept\s*:\s*[^?]/.test(f.code))
      .map((f) => f.rel)
      .sort()
    expect(sites).toEqual(['server/executor/jcode.ts', 'server/executor/sdk-transport.ts'])
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
