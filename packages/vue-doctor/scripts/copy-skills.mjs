import { cp, mkdir, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoSkill = resolve(packageRoot, '../../skills/vue-doctor')
const packageSkill = resolve(packageRoot, 'skills/vue-doctor')
const distSkill = resolve(packageRoot, 'dist/skills/vue-doctor')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const source = (await exists(join(repoSkill, 'SKILL.md')))
  ? repoSkill
  : (await exists(join(packageSkill, 'SKILL.md')))
    ? packageSkill
    : null

if (!source) {
  console.warn('[vue-doctor] skill source not found; skipping skill copy')
  process.exit(0)
}

await mkdir(dirname(distSkill), { recursive: true })
await mkdir(dirname(packageSkill), { recursive: true })
await cp(source, distSkill, { recursive: true })
// Keep a package-local copy for packaging `files: ["skills"]`.
await cp(source, packageSkill, { recursive: true })
console.log(`[vue-doctor] copied skill from ${source}`)
