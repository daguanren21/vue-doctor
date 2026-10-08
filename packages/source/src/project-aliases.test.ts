import { describe, expect, test } from 'vitest'
import { matchProjectAlias, readProjectAliases } from './project-aliases.js'

function reader(files: Record<string, string>) {
  return async (file: string) => files[file]
}

describe('explicit project alias evidence', () => {
  test('inherits JSONC paths relative to their declaring config and honors child replacement', async () => {
    const inherited = await readProjectAliases('/app', reader({
      '/app/tsconfig.json': '{ "extends": "./config/base" }',
      '/app/config/base.json': '{ /* static */ "compilerOptions": { "paths": { "@/*": ["../src/*"] } }, }'
    }))
    expect(matchProjectAlias('@/App.vue', inherited)).toEqual(['/app/src/App.vue'])
    const replaced = await readProjectAliases('/app', reader({
      '/app/tsconfig.json': '{ "extends": "./config/base", "compilerOptions": { "baseUrl": ".", "paths": { "#/*": ["ui/*"] } } }',
      '/app/config/base.json': '{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }',
      '/app/jsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["wrong/*"] } } }'
    }))
    expect(matchProjectAlias('@/App.vue', replaced)).toBeUndefined()
    expect(matchProjectAlias('#/App.vue', replaced)).toEqual(['/app/ui/App.vue'])
  })

  test('uses exact and longest-prefix matches, preserving fallback target order', () => {
    const aliases = [
      { pattern: '@/*', targets: ['/app/src/*'] },
      { pattern: '@/pages/*', targets: ['/app/pages/*', '/app/fallback/*'] },
      { pattern: '@/pages/Home', targets: ['/app/Home.vue'] }
    ]
    expect(matchProjectAlias('@/pages/Home', aliases)).toEqual(['/app/Home.vue'])
    expect(matchProjectAlias('@/pages/About', aliases)).toEqual(['/app/pages/About', '/app/fallback/About'])
    expect(matchProjectAlias('unknown/App', aliases)).toBeUndefined()
  })

  test('retains declaration order when matching alias prefixes tie', () => {
    const aliases = [
      { pattern: '@/*', targets: ['/app/src/*'] },
      { pattern: '@/*.ts', targets: ['/app/legacy/*.ts'] }
    ]
    expect(matchProjectAlias('@/install.ts', aliases)).toEqual(['/app/src/install.ts'])
    expect(matchProjectAlias('@/install.ts', [...aliases].reverse())).toEqual(['/app/legacy/install.ts'])
  })

  test('does not treat declaration-only package redirects as runtime aliases', async () => {
    const aliases = await readProjectAliases('/app', reader({
      '/app/tsconfig.json': JSON.stringify({ compilerOptions: { paths: {
        'state-lib': ['./node_modules/state-lib/types/index.d.ts'],
        '@/*': ['./src/*'],
        'local-lib': ['./types/local-lib.d.ts', './src/local-lib.ts']
      } } })
    }))
    expect(matchProjectAlias('state-lib', aliases)).toBeUndefined()
    expect(matchProjectAlias('@/App.vue', aliases)).toEqual(['/app/src/App.vue'])
    expect(matchProjectAlias('local-lib', aliases)).toEqual(['/app/types/local-lib.d.ts', '/app/src/local-lib.ts'])
  })

  test('rejects cycles, nonlocal inheritance and non-static or malformed configuration', async () => {
    await expect(readProjectAliases('/app', reader({
      '/app/tsconfig.json': '{ "extends": "./tsconfig.json" }'
    }))).rejects.toThrow('inheritance cycle')
    await expect(readProjectAliases('/app', reader({
      '/app/tsconfig.json': '{ "extends": "remote-config" }'
    }))).rejects.toThrow('unsupported')
    await expect(readProjectAliases('/app', reader({
      '/app/tsconfig.json': '{ "compilerOptions": { "baseUrl": 123 } }'
    }))).rejects.toThrow('non-static')
    await expect(readProjectAliases('/app', reader({
      '/app/tsconfig.json': 'export default getConfig()'
    }))).rejects.toThrow('JSONC')
    expect(await readProjectAliases('/app', reader({}))).toEqual([])
  })
})
