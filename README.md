# exp-spec

Experimental Chrome extension for annotating spec pages (and any HTML page) with AI-assisted markers.

Two decoupled modules:

1. **Marker engine** — drop persistent, re-anchorable markers on any element of any web page. Framework-agnostic, usable outside the extension.
2. **Browser copilot** — a small LLM agent (in the extension) triggered by markers, with tools to read the page, manage markers, and reply in threads.

Status: planning. See `PLAN.md` (on the plan branch / PR) for the full design.

Internal tool — not intended for Chrome Web Store publication.
