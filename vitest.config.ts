import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@vue-doctor/rule-pack-dead-code': new URL('./packages/rule-pack-dead-code/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/rule-pack-eslint': new URL('./packages/rule-pack-eslint/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/rules-eslint': new URL('./packages/rules-eslint/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/inspector-protocol': new URL('./packages/inspector-protocol/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/component-library': new URL('./packages/component-library/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/core/domains': new URL('./packages/core/src/domains.ts', import.meta.url).pathname,
      '@vue-doctor/core/report-schema': new URL('./packages/core/src/report-schema.ts', import.meta.url).pathname,
      '@vue-doctor/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/diagnostic-reference': new URL('./packages/diagnostic-reference/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/inspector/host': new URL('./packages/inspector/src/host.ts', import.meta.url).pathname,
      '@vue-doctor/inspector/mcp': new URL('./packages/inspector/src/mcp.ts', import.meta.url).pathname,
      '@vue-doctor/inspector/devframe': new URL('./packages/inspector/src/devframe.ts', import.meta.url).pathname,
      '@vue-doctor/inspector/protocol': new URL('./packages/inspector/src/protocol.ts', import.meta.url).pathname,
      '@vue-doctor/inspector/store': new URL('./packages/inspector/src/report-store.ts', import.meta.url).pathname,
      '@vue-doctor/inspector': new URL('./packages/inspector/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/rule-pack-component-library/rules': new URL('./packages/rule-pack-component-library/src/rules.ts', import.meta.url).pathname,
      '@vue-doctor/rule-pack-component-library': new URL('./packages/rule-pack-component-library/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/rule-pack-vue/rules': new URL('./packages/rule-pack-vue/src/rules.ts', import.meta.url).pathname,
      '@vue-doctor/rule-pack-vue': new URL('./packages/rule-pack-vue/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/runner': new URL('./packages/runner/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/rules': new URL('./packages/rules/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/source': new URL('./packages/source/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/unplugin': new URL('./packages/unplugin/src/index.ts', import.meta.url).pathname,
      '@vue-doctor/vite': new URL('./packages/vite/src/index.ts', import.meta.url).pathname
    }
  }
})
