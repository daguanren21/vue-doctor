import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(rootManifest.private, true, 'The workspace root must remain private.')
const list = JSON.parse(execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
  cwd: root,
  encoding: 'utf8'
}))
const workspace = []
for (const project of list) {
  const directory = resolve(project.path)
  const path = relative(root, directory).split(sep).join('/')
  assert(path !== 'packages/rule-pack-company', 'Private extensions must stay outside the public workspace.')
  if (directory === resolve(root)) continue
  assert(path.startsWith('packages/') && !path.includes('../'), `Unexpected release workspace: ${path}`)
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  assert(/^@daguanren21\/vue-doctor(?:-[a-z0-9-]+)?$/.test(manifest.name), `Unexpected package: ${manifest.name}`)
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, `Missing runtime file allowlist: ${manifest.name}`)
  if (manifest.name === '@daguanren21/vue-doctor') {
    assert.equal(path, 'packages/vue-doctor', 'The public facade must own the CLI package.')
    assert(manifest.private !== true, 'The CLI facade must remain publishable.')
    assert.equal(manifest.publishConfig?.access, 'public', 'The CLI must publish with public access.')
    assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/', 'Unexpected CLI registry.')
  } else {
    assert.equal(manifest.private, true, `Internal workspace must not be independently published: ${manifest.name}`)
  }
  workspace.push({ path, manifest })
}
const names = new Set(workspace.map(({ manifest }) => manifest.name))
assert.equal(names.size, workspace.length, 'Duplicate workspace package name.')
const publicPackages = workspace.filter(({ manifest }) => manifest.private !== true)
assert.deepEqual(publicPackages.map(({ manifest }) => manifest.name), ['@daguanren21/vue-doctor'], 'Only the CLI facade may be published.')
for (const { manifest } of workspace) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      assert(!name.startsWith('@vue-doctor/'), `Unmigrated or excluded dependency in ${manifest.name}: ${name}`)
      if (String(version).startsWith('workspace:')) assert(names.has(name), `Excluded workspace dependency in ${manifest.name}: ${name}`)
      assert(!/^(?:file|link):/.test(String(version)), `Local dependency in ${manifest.name}: ${name}`)
      if (manifest.name === '@daguanren21/vue-doctor' && field !== 'devDependencies') {
        assert(!names.has(name), `Public runtime must bundle internal workspace ${name}, not depend on its publication.`)
      }
    }
  }
}
console.log(`Public release: @daguanren21/vue-doctor only; ${workspace.length - 1} internal workspace packages remain private.`)
