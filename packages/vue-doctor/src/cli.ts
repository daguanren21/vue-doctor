#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as CliRuntime from './cli-runtime.js'

const entryUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)))
const runtimeUrl = new URL('./cli-runtime.mjs', entryUrl)
// Resolve the runtime from the physical package before linking its dependencies;
// --preserve-symlinks-main otherwise hides pnpm's package-local dependency tree.
const runtime: typeof CliRuntime = await import(runtimeUrl.href)
process.exitCode = await runtime.runCli()
