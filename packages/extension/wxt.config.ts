import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'exp-spec',
    description: 'Anchored comment threads + browser copilot (internal)',
    // `tabs` is what makes `tabForPageKey` work: `tabs.query({})` only returns `url` for tabs
    // the extension may see, and the tool transport routes by the RUN's page rather than by
    // whatever tab happens to be focused.
    permissions: ['storage', 'alarms', 'unlimitedStorage', 'tabs'],
    // Extension-context requests to a host in `host_permissions` bypass CORS entirely — no
    // proxy server (PLAN §4.4).
    host_permissions: ['https://api.anthropic.com/*'],
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
