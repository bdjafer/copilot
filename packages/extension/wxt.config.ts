import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'exp-spec',
    description: 'Anchored comment threads + browser copilot (internal)',
    // `tabs` is what makes `tabsForPageKey` work: `tabs.query({})` only returns `url` for tabs
    // the extension may see, and the tool transport routes by the RUN's page rather than by
    // whatever tab happens to be focused.
    permissions: ['storage', 'alarms', 'unlimitedStorage', 'tabs'],
    // Extension-context requests to a host in `host_permissions` bypass CORS entirely — no
    // proxy server (PLAN §4.4). The two loopback entries are the swarm head's `POST /pair`
    // (SPEC-swarm §2.1): the swarm server sends no `Access-Control-Allow-Origin` and needs none,
    // and §2.1's `Host` check accepts exactly `127.0.0.1:<port>` and `localhost:<port>` — so both
    // spellings are declared rather than leaving one of them failing with a CORS error whose cause
    // is invisible. The WebSocket needs no entry: an extension page's `connect-src` is not
    // restricted by the default MV3 CSP, and the token rides in the subprotocol list (S4), never
    // in the URL.
    host_permissions: ['https://api.anthropic.com/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    // `chrome.commands` cannot bind a bare letter, so these are the backup path for the two
    // placement triggers; the primary path is the engine's own capture-phase key listener.
    commands: {
      'place-comment': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Place a comment thread',
      },
      'place-ask': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: 'Place an ask thread',
      },
    },
  },
})
