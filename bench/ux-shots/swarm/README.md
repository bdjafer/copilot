# swarm head — visual pass

Chrome (agent-browser 0.32.2) with `packages/extension/.output/chrome-mv3` loaded unpacked,
against `pnpm --filter @astrale-os/swarm demo:serve` on `127.0.0.1:7717` (mock executor).

| Shot | What it shows |
| --- | --- |
| `01-pairing.png` | the first-run pairing card: endpoint pre-filled, 8-character code, one button |
| `02-pair-refused-403-BEFORE-FIX.png` | **the bug this pass found.** A real extension origin was refused `403: forbidden origin` — the default `origins` allowlist shipped loopback entries only, so the primary head could never pair. Kept as the before-picture; fixed in `src/server/config.ts` + `originAllowed`. |
| `03-fleet-with-delegation.png` | paired and connected: `connected · 0/4 running · 0 queued · $0.00 spend`, the four honesty notices, and a `create refused — workspace_denied: workspace '' is not registered` from the composer |
| `04-fleet-row.png` | a delegation created by the CLI arriving live in the head: bucket `NEEDS YOU 1`, the row, and the `unverifiable-turn-end` badge |

## What a human should eyeball

1. **The composer sends an empty `workspaceId` on a first run.** Deviation E3 seeds the workspace
   picker from "ids already in use plus free text", and on an empty fleet there are no ids in use —
   so a brand-new user's first create is refused `workspace_denied: workspace '' is not registered`.
   The refusal is honest and legible, and it is still a dead end: nothing in the head tells the user
   what a valid id would be. The allowlist lives in the server's `config.json` and no view model
   carries it. This is the last first-run gap in the extension head.
2. ~~**`lagged — entries were dropped under backpressure` on an empty transcript.**~~ **FIXED — and
   it was never the lag flag.** `render()` does `setAttr(lagged, 'hidden', vm.lagged ? null : '')`
   correctly; the attribute simply did nothing. `ui/styles.ts` declared `display` on class
   selectors and shipped **no** `[hidden] { display: none }` rule, and the UA's own is specificity
   0-1-0, so every author class beat it. Verified in Chrome against the real declarations before
   the fix: `.cc-detail[hidden]` → `flex`, `.cc-lagged[hidden]` → `flex`, bare `div[hidden]` →
   `none`. Items 2 and 4 here, and the empty-stack half of 3, were **one** missing CSS rule
   reported as three open questions. `packages/extension/src/content/pill.ts:46` already carried
   the rule; the new sheet omitted it. Now pinned by an *effect* assertion (computed `display`,
   every `.cc-*` class in the sheet) in `test/swarm-design.test.ts` — the surface tests could not
   catch it because they assert `hasAttribute('hidden')`, which was true either way.
3. **The notice stack overlaps the transcript pane** at this viewport (1200 logical px wide) and
   covers the follow-up composer. Four non-dismissible-by-design honesty notices plus one error is
   the *normal* steady state, not an edge case. **Still open** — the missing `[hidden]` rule
   explains why the `position: fixed` stack kept its footprint when *empty*, but not the overlap
   when it is full. That is a layout decision, and it is a real one.
4. ~~**The detail pane renders its section frames with nothing focused.**~~ **FIXED by the same
   rule.** `ui/detail.ts:253` hides `.cc-detail` when nothing is focused and returns before
   painting; the pane stayed visible, so the unpopulated frames in `03` are the empty sections it
   had already built. Nothing was leaking — the hide was inert.
5. Compare `04` against `swarm ls`: the bucket, the row title and the badge should agree, and did.

The shots above are the **pre-fix** state for items 2 and 4. They are kept rather than retaken for
the same reason `02-pair-refused-403-BEFORE-FIX.png` is: a before-picture of a defect that shipped
is worth more than a clean one of a build nobody can check out.
