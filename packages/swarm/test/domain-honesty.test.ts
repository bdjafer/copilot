/**
 * SPEC-swarm §10 release gate 10 — the in-product honesty surface (S8, S10, S11).
 *
 * `NoticeKind` has carried `'honesty'` since §6.4 was written and nothing ever produced one:
 * `HealthVM.honesty` was a declared field with no writer, so the gate that depends on it could
 * only ever have been passed by inspection. These cases make it code.
 *
 * The property being tested is unusual — it is that swarm says the *unflattering* thing — so each
 * case asserts the content, not merely the presence of a row.
 */

import { describe, expect, it } from 'vitest'

import {
  AMBIENT_AUTH_METHODS,
  HONESTY_IDS,
  ambientRoutesOf,
  honestyNotices,
  honestyStatements,
} from '../src/domain/honesty.ts'
import { createTestClient } from '../src/testing/client-harness.ts'

describe('§10 gate 10: the statements swarm always makes', () => {
  it('always admits it has no tool authority (S8) and is not a sandbox (S11)', () => {
    const ids = honestyStatements().map((s) => s.id)
    expect(ids).toContain('honesty.no-tool-authority')
    expect(ids).toContain('honesty.not-a-sandbox')
  })

  it('and neither is dismissible, because both describe what swarm IS', () => {
    /* A dismissible admission is one the user stops seeing after day one. S8 and S11 are not
     * events that happened; they are the product. */
    for (const id of ['honesty.no-tool-authority', 'honesty.not-a-sandbox']) {
      expect(honestyStatements().find((s) => s.id === id)?.dismissible).toBe(false)
    }
  })

  it('says the specific true thing, not a hedge', () => {
    const s8 = honestyStatements().find((s) => s.id === 'honesty.no-tool-authority')!
    /* [R3]/#28 deleted `writeMode: 'readonly'` rather than ship a gate that does not gate. The
     * UI has to carry the same claim the spec does, or the deletion bought nothing. */
    expect(s8.detail).toMatch(/no read-only mode/i)
    expect(s8.detail).toMatch(/any command you can/i)

    const s11 = honestyStatements().find((s) => s.id === 'honesty.not-a-sandbox')!
    expect(s11.detail).toMatch(/does not use a container or a VM/i)
    /* Q6/#15: network allowlisting without a container is unenforceable, so it is not claimed. */
    expect(s11.detail).toMatch(/does not enforce network restrictions/i)
  })

  it('always labels effort as declared, never confirmed (§4.3.4, §5.4 #11)', () => {
    const effort = honestyStatements().find((s) => s.id === 'honesty.effort-declared')
    expect(effort).toBeDefined()
    expect(effort?.detail).toMatch(/cannot read back/i)
  })

  it('every id it can produce is declared, so a head can style them without literals', () => {
    const produced = new Set(
      honestyStatements({ anyInheritedLogins: true, ambientRoutes: ['gpt-5.6-pro[web]'] }).map(
        (s) => s.id,
      ),
    )
    expect([...produced].sort()).toEqual([...HONESTY_IDS].sort())
  })
})

describe('§10 gate 10: the statements that depend on the deployment', () => {
  it('says nothing about inherited logins unless the head declares them (S10)', () => {
    /* Absent means "not claimed". Asserting isolation the client cannot observe would be the
     * same class of lie the whole surface exists to avoid. */
    expect(honestyStatements().map((s) => s.id)).not.toContain('honesty.inherited-logins')
    expect(honestyStatements({ anyInheritedLogins: true }).map((s) => s.id)).toContain(
      'honesty.inherited-logins',
    )
  })

  it("warns that inherited logins spend the user's own quota", () => {
    const row = honestyStatements({ anyInheritedLogins: true }).find(
      (s) => s.id === 'honesty.inherited-logins',
    )!
    expect(row.detail).toMatch(/your own subscription or API quota/i)
  })

  it('names the routes that can spend quota even with NO inherited login', () => {
    /*
     * Verified on jcode 0.67.0: a `JCODE_HOME` created seconds earlier, with no credentials in
     * it, still reports `{ model: 'gpt-5.6-pro[web]', api_method: 'chatgpt-web', available: true,
     * detail: 'logged-in Firefox ChatGPT session' }`. That route authenticates from the user's
     * browser profile under `$HOME`, which the agent needs and swarm therefore passes through.
     * S10's promise is incomplete in exactly one place, and this is that place said out loud.
     */
    const row = honestyStatements({ ambientRoutes: ['gpt-5.6-pro[web]'] }).find(
      (s) => s.id === 'honesty.ambient-credentials',
    )
    expect(row).toBeDefined()
    expect(row?.detail).toMatch(/gpt-5\.6-pro\[web\]/)
    expect(row?.detail).toMatch(/browser profile/i)
  })

  it('derives those routes from a health snapshot rather than from a guess', () => {
    expect(AMBIENT_AUTH_METHODS).toContain('chatgpt-web')
    const routes = [
      { model: 'claude-opus-5', apiMethod: 'claude-oauth' },
      { model: 'gpt-5.6-pro[web]', apiMethod: 'chatgpt-web' },
      { model: 'gpt-5.5-pro', apiMethod: 'openai-api-key' },
    ]
    expect(ambientRoutesOf(routes)).toEqual(['gpt-5.6-pro[web]'])
    expect(ambientRoutesOf([])).toEqual([])
  })
})

describe("§6.4 the notices carry kind 'honesty'", () => {
  it('produces notices, not just panel rows, and every one is `honesty`', () => {
    const notices = honestyNotices({ at: 1_000 })
    expect(notices.length).toBeGreaterThan(0)
    for (const notice of notices) expect(notice.kind).toBe('honesty')
  })

  it('ranks them `info`: nothing has gone wrong, and crying wolf costs the real warnings', () => {
    for (const notice of honestyNotices({ at: 1_000 })) expect(notice.severity).toBe('info')
  })

  it('a sensitive workspace pins the tool-authority notice open ([R3], §5.5)', () => {
    const ordinary = honestyNotices({ at: 1 }).find((n) => n.id === 'honesty.no-tool-authority')!
    const sensitive = honestyNotices({ at: 1, anySensitiveWorkspace: true }).find(
      (n) => n.id === 'honesty.no-tool-authority',
    )!
    /* Non-dismissible in both, but the spec's wording is specifically about the sensitive case,
     * so the sensitive one must never regress to dismissible even if the default changes. */
    expect(ordinary.dismissible).toBe(false)
    expect(sensitive.dismissible).toBe(false)
    expect(sensitive.actions).toEqual([])
  })

  it('the dismissible ones offer a dismiss action and the pinned ones offer none', () => {
    const notices = honestyNotices({ at: 1, anyInheritedLogins: true })
    for (const notice of notices) {
      expect(notice.actions.length > 0).toBe(notice.dismissible)
    }
  })
})

describe('§10 gate 10: the client actually raises them', () => {
  it('publishes honesty notices once health arrives', () => {
    const harness = createTestClient()
    harness.start()

    const ids = harness.client.notices.get().map((notice) => notice.id)
    expect(ids).toContain('honesty.no-tool-authority')
    expect(ids).toContain('honesty.not-a-sandbox')
    harness.destroy()
  })

  it('carries the S10 badge only when the head declared inherited logins', () => {
    const plain = createTestClient()
    plain.start()
    expect(plain.client.notices.get().map((n) => n.id)).not.toContain('honesty.inherited-logins')
    plain.destroy()

    const inherited = createTestClient({ inheritedLogins: true })
    inherited.start()
    expect(inherited.client.notices.get().map((n) => n.id)).toContain('honesty.inherited-logins')
    inherited.destroy()
  })

  it('does not accumulate duplicates as health changes — the ids are stable', () => {
    const harness = createTestClient()
    harness.start()
    const before = harness.client.notices.get().filter((n) => n.kind === 'honesty').length
    harness.start()
    const after = harness.client.notices.get().filter((n) => n.kind === 'honesty').length
    expect(after).toBe(before)
    harness.destroy()
  })
})
