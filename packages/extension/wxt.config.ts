import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'exp-spec',
    description: 'Anchored comment threads + browser copilot (internal)',
    permissions: ['storage', 'alarms', 'unlimitedStorage'],
    host_permissions: ['https://api.anthropic.com/*'],
  },
})
