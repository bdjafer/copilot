# exp-spec

Experimental Chrome extension for commenting on spec pages (and any HTML page) with an
AI copilot replying in threads.

Two fully independent modules — each usable as a standalone library:

1. **Comment engine** (`comment-core` + `comment-ui`) — persistent, re-anchorable
   comment threads on any element of any web page: flat replies, resolve/reopen
   lifecycle, robust to dynamic DOM. No extension, no AI required.
2. **Copilot** (`copilot`) — a generic browser LLM agent runtime: trigger/listen API,
   host-registered tools, background run queue. Zero knowledge of comments.

The MV3 extension is the only bridge between the two.

Status: planning. See `PLAN.md` (plan branch / PR #1) for the full design.

Internal tool — not intended for Chrome Web Store publication.
