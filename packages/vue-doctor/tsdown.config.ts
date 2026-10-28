import { isAbsolute } from 'node:path'
import { defineConfig } from 'tsdown'

const internalPackage = /^@daguanren21\/vue-doctor-/
const neverBundle = (id: string) => !internalPackage.test(id)
  && !id.startsWith('.') && !id.startsWith('\0') && !isAbsolute(id)

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    rules: 'src/rules.ts',
    'rules-eslint': 'src/rules-eslint.ts',
    vite: 'src/vite.ts',
    webpack: 'src/webpack.ts',
    rspack: 'src/rspack.ts',
    rollup: 'src/rollup.ts',
    rolldown: 'src/rolldown.ts',
    esbuild: 'src/esbuild.ts',
    unplugin: 'src/unplugin.ts',
    cli: 'src/cli.ts',
    'cli-runtime': 'src/cli-runtime.ts',
    'source-worker': 'src/source-worker.ts'
  },
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  dts: true,
  sourcemap: false,
  deps: {
    alwaysBundle: [internalPackage],
    neverBundle,
    onlyBundle: [internalPackage],
    dts: {
      alwaysBundle: [internalPackage],
      neverBundle
    }
  }
})
