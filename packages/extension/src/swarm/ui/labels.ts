/**
 * `SwarmLabels` — the locked 19-key i18n interface of SPEC-swarm §6.8, filled in once.
 *
 * DESIGN §10's thesis applies verbatim: **`Labels` stops being a visual layer and becomes the
 * accessibility layer.** Almost none of these strings is drawn — `send`, `cancel`, `retry`,
 * `verify`, `accept`, `land`, `compare`, `pause`, `resume`, `confirm`, `deny`, `dismiss`,
 * `killSwitch` and `hardKill` are all icons with a native `title`, and `emptyFleet` is an
 * `aria-label` on an empty list drawn as one 20 px glyph in 64 px of air.
 *
 * Exactly three are visible, and each is a value or the only thing naming a box:
 * `placeholder` (the composer's), `effortDeclared` and `effortInherited` — the two honesty labels
 * §4.3.4 makes MANDATORY to render, because an effort this system cannot confirm must never be
 * drawn as if it could.
 */

import type { SwarmLabels } from '@astrale-os/swarm/presentation'

export const SWARM_LABELS: SwarmLabels = {
  send: 'send this message',
  cancel: 'cancel this delegation',
  cancelTurn: 'cancel the turn in flight — the session survives',
  hardKill: 'hard kill the instance and its children',
  retry: 'retry as a new attempt',
  verify: 'run the acceptance criteria',
  accept: 'accept with a written verdict',
  land: 'land this attempt',
  compare: 'compare the attempts',
  pause: 'pause dispatch',
  resume: 'resume dispatch',
  confirm: 'confirm',
  deny: 'deny',
  dismiss: 'dismiss',
  killSwitch: 'cancel every in-flight turn and pause dispatch fleet-wide',
  effortDeclared: 'declared, not confirmed',
  effortInherited: 'inherited from the previous turn',
  emptyFleet: 'no delegations yet',
  placeholder: 'what should be done, and what must be true when it is',
}
