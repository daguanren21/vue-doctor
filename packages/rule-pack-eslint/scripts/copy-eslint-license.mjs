import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
await copyFile(
  join(dirname(require.resolve('eslint/package.json')), 'LICENSE'),
  new URL('../dist/ESLINT-LICENSE', import.meta.url)
)
