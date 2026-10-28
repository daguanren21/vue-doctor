import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('repoctl/package.json')), 'bin/repo.js')
const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type Runtime = { name: string; version: string; onFail: 'download' }
const nodeRuntime: Runtime = { name: 'node', version: '^26.0.0', onFail: 'download' }

for (const scenario of [
  { name: 'object runtime', runtimes: nodeRuntime, autoInstallPeers: true, expected: 'pass' },
  { name: 'runtime array', runtimes: [nodeRuntime], autoInstallPeers: true, expected: 'pass' },
  { name: 'runtime without automatic peers', runtimes: nodeRuntime, autoInstallPeers: false, expected: 'pass' },
  { name: 'changed runtime version', runtimes: { ...nodeRuntime, version: '^24.0.0' }, autoInstallPeers: true, expected: 'fail' },
  { name: 'removed runtime declaration', runtimes: undefined, autoInstallPeers: true, expected: 'fail' },
  { name: 'missing runtime lock entry', runtimes: nodeRuntime, autoInstallPeers: true, missingRuntime: true, expected: 'fail' },
  { name: 'ordinary dependency drift', runtimes: nodeRuntime, autoInstallPeers: true, ordinaryDrift: true, expected: 'fail' }
] as const) {
  test(`repoctl checks ${scenario.name} without ignoring dependency mismatches`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-repoctl-runtime-'))
    roots.push(root)
    const home = join(root, 'home')
    const emptyNpmrc = join(home, 'empty.npmrc')
    await mkdir(home)
    await writeFile(emptyNpmrc, '')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'synthetic-runtime-fixture', private: true, version: '1.0.0',
      packageManager: 'pnpm@12.15.0',
      ...(scenario.runtimes ? { devEngines: { runtime: scenario.runtimes } } : {}),
      ...('ordinaryDrift' in scenario ? { devDependencies: { 'synthetic-dependency': '1.0.0' } } : {})
    }))
    // JSON is a YAML mapping; these fixtures retain pnpm's observed runtime: specifier shape.
    await writeFile(join(root, 'pnpm-workspace.yaml'), JSON.stringify({
      packages: [], autoInstallPeers: scenario.autoInstallPeers
    }))
    await writeFile(join(root, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0', settings: { autoInstallPeers: scenario.autoInstallPeers },
      importers: { '.': { devDependencies: 'missingRuntime' in scenario ? {} : {
        node: { specifier: 'runtime:^26.0.0', version: 'runtime:26.12.1' }
      } } }, packages: {}, snapshots: {}
    }))
    const result = await run(process.execPath, [cli, 'doctor', '--rules', 'lockfile-sync', '--json', '--redact'], {
      cwd: root,
      env: {
        HOME: home,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        NPM_CONFIG_USERCONFIG: emptyNpmrc,
        PNPM_CONFIG_NPMRC_AUTH_FILE: emptyNpmrc
      },
      encoding: 'utf8'
    }).then(({ stdout }) => ({ code: 0, stdout }), (error: unknown) => {
      if (!error || typeof error !== 'object' || !('stdout' in error) || !('code' in error)
        || typeof error.stdout !== 'string' || typeof error.code !== 'number') throw error
      return { code: error.code, stdout: error.stdout }
    })
    const report: { checks: Array<{ id: string; status: string }> } = JSON.parse(result.stdout)
    expect(report.checks).toEqual([expect.objectContaining({ id: 'lockfile-sync', status: scenario.expected })])
    expect(result.code).toBe(scenario.expected === 'pass' ? 0 : 1)
  })
}
