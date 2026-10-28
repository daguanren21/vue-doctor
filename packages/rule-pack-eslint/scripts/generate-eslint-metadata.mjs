import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { extractCoreRuleMetadata } from '../src/core-rule-metadata.ts'

const require = createRequire(import.meta.url)
const { version } = require('eslint/package.json')
const { builtinRules } = require('eslint/use-at-your-own-risk')
const metadata = extractCoreRuleMetadata(builtinRules)
const license = await readFile(join(dirname(require.resolve('eslint/package.json')), 'LICENSE'), 'utf8')

await writeFile(new URL('../src/core-rule-metadata.generated.ts', import.meta.url), `// Generated from eslint@${version} by scripts/generate-eslint-metadata.mjs; do not edit.
/*
ESLint documentation metadata is distributed under the following MIT license:
${license.trimEnd()}
*/
import type { CoreRuleMetadata } from './core-rule-metadata.js'

export const eslintMetadataVersion = ${JSON.stringify(version)}
export const eslintCoreRuleMetadata: readonly CoreRuleMetadata[] = [
${metadata.map(rule => `  ${JSON.stringify(rule)}`).join(',\n')}
]
`)
console.log(`Generated metadata for ${metadata.length} rules from ESLint ${version}.`)
