# bench

agent-browser scenarios + real-site corpus for anchoring robustness (PLAN.md §3.8).

- [`run.md`](./run.md) — how the bench is run, what it asserts, the scenario matrix.
- [`results.md`](./results.md) — the outcome table and every failure, written up.

| File | What it is |
| --- | --- |
| `run.mjs` | the seven demo-page scenarios (`node bench/run.mjs [name…]`) |
| `sites.mjs` | the real-site smoke (`node bench/sites.mjs`) |
| `lib/driver.mjs` | the agent-browser layer: page actions, in-page probes, `placeComment` |
| `results.json` / `results-sites.json` | raw evidence from the last full run |
| `shots/` | screenshots — evidence for a human, never the test |
