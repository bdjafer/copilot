/**
 * OS notifications for a server with **no head attached** (SPEC-swarm §10, §4.3).
 *
 * The whole reason this file exists is the case where nobody is looking. `DeliveryDefaults.notify`
 * is `'silent' | 'notify'`, and `'notify'` is worth nothing while a head is connected — the head
 * already renders `NoticeVM` and the attention score. The moment the extension is closed or the
 * laptop lid comes down, a delegation that reaches `needs-you` has no way to say so, and swarm's
 * central promise ("it keeps working while you are not watching") becomes "it stops and waits and
 * never tells you".
 *
 * Three rules, and each is a refusal:
 *
 *  1. **Never a shell.** Every notification carries a delegation title, which is user text that
 *     arrived over the wire. `execFile` with an argv array, never `exec`, never a template string
 *     — a delegation titled `"; rm -rf ~"` must be a strange-looking notification and nothing
 *     else. On macOS the AppleScript is a *constant* that reads its text from `argv`, so the
 *     title never becomes script source either.
 *  2. **Never fatal.** A notifier that throws would take down the turn it was reporting on. Every
 *     failure path — no binary, non-zero exit, a platform with no mechanism at all — resolves
 *     `false`. A missed notification is a missed notification; a crashed server is an outage.
 *  3. **Never when a head is watching.** `notifyIfUnattended` takes the head count and returns
 *     `'suppressed-head-attached'` rather than duplicating what the UI already shows.
 *
 * Node ≥ 24, server-only.
 */

import { execFile } from 'node:child_process'
import { platform } from 'node:process'

/** Why a notification did or did not go out. Every path is reported, none throws. */
export type NotifyOutcome =
  | 'sent'
  | 'suppressed-head-attached'
  | 'suppressed-silent'
  | 'unsupported-platform'
  | 'failed'

export interface NotifyRequest {
  readonly title: string
  readonly body: string
  /** `'notify' | 'silent'` from `DeliveryDefaults`; `'silent'` short-circuits everything. */
  readonly mode?: 'silent' | 'notify'
}

/** Injected so tests never shell out and a host can supply its own mechanism. */
export interface NotifyRunner {
  (
    command: string,
    args: readonly string[],
  ): Promise<{ readonly ok: boolean; readonly stderr: string }>
}

export interface NotifierOptions {
  readonly runner?: NotifyRunner
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: string
  /** Shown as the notification source. */
  readonly appName?: string
  readonly timeoutMs?: number
}

const defaultRunner: NotifyRunner = (command, args) =>
  new Promise((resolve) => {
    /* `execFile`, not `exec`: no shell is spawned, so the argv is data and can never be parsed as
     * a command. This is the single most important line in the file. */
    execFile(command, [...args], { timeout: 5_000 }, (error, _stdout, stderr) => {
      resolve({ ok: error === null, stderr: String(stderr ?? '') })
    })
  })

/**
 * The AppleScript is a **constant**. It reads both strings out of `argv`, so no part of a
 * delegation title is ever concatenated into script source — the failure mode that makes
 * `osascript -e "display notification \"" + title + "\""` a code-execution bug rather than a
 * quoting bug.
 */
const OSASCRIPT_TEMPLATE =
  'on run argv\n' +
  '  display notification (item 1 of argv) with title (item 2 of argv)\n' +
  'end run'

/**
 * Strip the control characters a notification mechanism might interpret, and bound the length.
 *
 * Not a security boundary — rule 1 is the security boundary, and this would be worthless without
 * it. It exists because a title containing a newline renders as a two-line notification on some
 * platforms and as a truncated one on others, and neither is what the user wrote.
 */
export function sanitizeNotificationText(text: string, max = 200): string {
  /* By code point rather than by a control-character class: the regex form is the one every
   * linter flags and every reader has to decode, and this says the same thing out loud. */
  let flattened = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    flattened += code < 0x20 || code === 0x7f ? ' ' : char
  }
  flattened = flattened.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max - 1)}\u2026` : flattened
}

export interface Notifier {
  notify(request: NotifyRequest): Promise<NotifyOutcome>
  /** The §10 case: notify **only** when no head is attached. */
  notifyIfUnattended(request: NotifyRequest, attachedHeads: number): Promise<NotifyOutcome>
  /** What this platform would use, or `null` — surfaced by `swarm doctor`. */
  readonly mechanism: string | null
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const runner = options.runner ?? defaultRunner
  const host = options.platform ?? platform
  const appName = options.appName ?? 'swarm'

  const mechanism = host === 'darwin' ? 'osascript' : host === 'linux' ? 'notify-send' : null

  const send = async (request: NotifyRequest): Promise<NotifyOutcome> => {
    if (request.mode === 'silent') return 'suppressed-silent'
    if (mechanism === null) return 'unsupported-platform'

    const body = sanitizeNotificationText(request.body)
    const title = sanitizeNotificationText(request.title || appName, 100)

    try {
      const result =
        mechanism === 'osascript'
          ? /* `-e <script> -- <body> <title>`: the script is a fixed literal and the two strings
             * are `argv` to it. Without `-e`, `osascript` would read the first argument as a
             * *file path*; with string concatenation instead of argv, a delegation title would be
             * AppleScript source. */
            await runner('osascript', ['-e', OSASCRIPT_TEMPLATE, body, title])
          : await runner('notify-send', ['--app-name', appName, title, body])
      return result.ok ? 'sent' : 'failed'
    } catch {
      /* Rule 2: a notifier that throws takes down the turn it was reporting on. */
      return 'failed'
    }
  }

  return {
    mechanism,
    notify: send,
    async notifyIfUnattended(request, attachedHeads) {
      /* Rule 3: the head already renders `NoticeVM`; a second copy on the desktop is noise, and
       * noise is how the notification that mattered gets muted. */
      if (attachedHeads > 0) return 'suppressed-head-attached'
      return send(request)
    },
  }
}

/** The one-line body §4.3 wants for a delegation that stopped and needs a human. */
export function needsYouNotification(input: {
  readonly title: string
  readonly reason: string
}): NotifyRequest {
  return {
    title: `swarm: ${input.title}`,
    body: `Needs you — ${input.reason}`,
    mode: 'notify',
  }
}
