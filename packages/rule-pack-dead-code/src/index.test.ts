import { access, mkdir, mkdtemp, readFile, rm, symlink, watch, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DoctorRulePackContext, DoctorRulePackResult } from '@vue-doctor/core'
import { afterEach, expect, test, vi } from 'vitest'
import { createDeadCodeRulePack } from './index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const ruleCodes = [
  'dead-code/unused-file',
  'dead-code/unused-export',
  'dead-code/unused-type',
  'dead-code/duplicate-export'
] as const

const graphConfig = { entry: ['src/entry.ts'], project: ['src/**/*.ts'] }
const findingSources = {
  'src/entry.ts': `import defaultDuplicate, { used, duplicate } from './library.ts'
console.log(used, duplicate, defaultDuplicate)
export const publicEntry = 4
export type PublicEntry = { value: string }
`,
  'src/library.ts': `export const used = 1
export const unused = 2
export type Unused = { value: string }
export const duplicate = 3
export default duplicate
`,
  'src/orphan.ts': 'export const orphan = true\n'
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-dead-code-'))
  roots.push(root)
  await Promise.all(Object.entries({
    'package.json': JSON.stringify({ name: 'dead-code-fixture', private: true, type: 'module' }),
    'knip.json': JSON.stringify(graphConfig),
    ...files
  }).map(async ([file, text]) => {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }))
  return root
}

function context(
  root: string,
  selected: string[],
  rules: DoctorRulePackContext['rules'] = {}
): DoctorRulePackContext {
  const files = selected.map(file => join(root, file))
  return {
    inventory: { root, packageJsonPath: join(root, 'package.json'), packages: {} },
    targetFiles: { root, files, issues: [] },
    source: { root, files, components: [], globalPlugins: [], fileResults: [] },
    components: [],
    rules
  }
}

function statuses(result: DoctorRulePackResult) {
  return Object.fromEntries(result.checks?.map(check => [check.ruleCode, check.status]) ?? [])
}

test('reports all four finding kinds at source-relative locations without flagging used or public entry exports', async () => {
  const root = await project(findingSources)
  const result = await createDeadCodeRulePack().run(context(root, Object.keys(findingSources)))

  expect(result.skippedChecks).toEqual([])
  expect(statuses(result)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'checked'])))
  expect(result.diagnostics).toHaveLength(4)
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'dead-code/unused-file',
      severity: 'warning',
      file: 'src/orphan.ts',
      primaryLocation: { file: 'src/orphan.ts', precision: 'file' }
    }),
    expect.objectContaining({
      code: 'dead-code/unused-export',
      severity: 'warning',
      file: 'src/library.ts',
      primaryLocation: { file: 'src/library.ts', start: { line: 2, column: 14 }, precision: 'point' }
    }),
    expect.objectContaining({
      code: 'dead-code/unused-type',
      severity: 'warning',
      file: 'src/library.ts',
      primaryLocation: { file: 'src/library.ts', start: { line: 3, column: 13 }, precision: 'point' }
    }),
    expect.objectContaining({
      code: 'dead-code/duplicate-export',
      severity: 'warning',
      file: 'src/library.ts',
      primaryLocation: { file: 'src/library.ts', start: { line: 4, column: 14 }, precision: 'point' },
    })
  ]))
})

test.each([
  ['a primitive', 42],
  ['null', null],
  ['a non-array issues payload', { issues: {} }],
  ['a null issue', { issues: [null] }],
  ['an unsupported issue after a valid entry', { issues: [
    { type: 'exports', filePath: 'src/library.ts', symbol: 'injected' },
    { type: 'dependencies', filePath: 'src/library.ts' }
  ] }],
  ['an unrequested issue type', { issues: [{ type: 'types', filePath: 'src/library.ts' }] }],
  ['a non-string file path', { issues: [{ type: 'exports', filePath: 42 }] }],
  ['a non-string error', { error: { message: 'configuration progress' } }]
] as const)('ignores trailing IPC containing %s without replacing valid findings', async (_name, message) => {
  const root = await project({
    ...findingSources,
    'ipc.config.mjs': `const send = process.send.bind(process)
process.send = (response, callback) => {
  send(response)
  return send(${JSON.stringify(message)}, callback)
}
export default ${JSON.stringify(graphConfig)}
`
  })
  const result = await createDeadCodeRulePack({ configFile: 'ipc.config.mjs' }).run(context(
    root, Object.keys(findingSources), { 'dead-code/unused-type': 'off' }
  ))

  expect(result.skippedChecks).toEqual([])
  expect(statuses(result)).toEqual({
    'dead-code/unused-file': 'checked',
    'dead-code/unused-export': 'checked',
    'dead-code/unused-type': 'disabled',
    'dead-code/duplicate-export': 'checked'
  })
  expect(result.diagnostics.map(({ code, file }) => [code, file]).sort()).toEqual([
    ['dead-code/unused-file', 'src/orphan.ts'],
    ['dead-code/unused-export', 'src/library.ts'],
    ['dead-code/duplicate-export', 'src/library.ts']
  ].sort())
})

test('accepts valid IPC issues without interpreting an accompanying non-string error', async () => {
  const root = await project({
    'src/entry.ts': 'export const publicEntry = 1\n',
    'src/orphan.ts': 'export const orphan = 2\n',
    'ipc.config.mjs': `const send = process.send.bind(process)
process.send = (response, callback) => {
  send({ issues: [] })
  return send({ ...response, error: { message: 'configuration progress' } }, callback)
}
export default ${JSON.stringify(graphConfig)}
`
  })
  const result = await createDeadCodeRulePack({ configFile: 'ipc.config.mjs' }).run(context(
    root, ['src/entry.ts', 'src/orphan.ts']
  ))

  expect(result.skippedChecks).toEqual([])
  expect(statuses(result)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'checked'])))
  expect(result.diagnostics).toMatchObject([{ code: 'dead-code/unused-file', file: 'src/orphan.ts' }])
})

test('retains consumers outside the selected library file while excluding out-of-scope orphan findings', async () => {
  const root = await project({
    'src/entry.ts': "import { used } from './library.ts'\nconsole.log(used)\n",
    'src/library.ts': 'export const used = 1\nexport const unused = 2\n',
    'src/orphan.ts': 'export const orphan = true\n'
  })
  const selected = context(root, ['src/library.ts'])
  selected.source.files = ['src/entry.ts', 'src/library.ts', 'src/orphan.ts'].map(file => join(root, file))
  const result = await createDeadCodeRulePack().run(selected)

  expect(result.skippedChecks).toEqual([])
  expect(result.diagnostics).toMatchObject([{
    code: 'dead-code/unused-export',
    file: 'src/library.ts',
    primaryLocation: { file: 'src/library.ts', start: { line: 2, column: 14 }, precision: 'point' }
  }])
})

test('preserves the project graph and report paths when the Doctor root is a directory symlink', async () => {
  const root = await project({
    'src/entry.ts': "import { used } from './library.ts'\nconsole.log(used)\n",
    'src/library.ts': 'export const used = 1\nexport const unused = 2\n'
  })
  const alias = `${root}-alias`
  roots.push(alias)
  await symlink(root, alias, 'junction')
  const result = await createDeadCodeRulePack({ configFile: 'knip.json' }).run(context(alias, ['src/library.ts']))

  expect(result.skippedChecks).toEqual([])
  expect(result.diagnostics).toMatchObject([{
    code: 'dead-code/unused-export',
    file: 'src/library.ts',
    primaryLocation: { file: 'src/library.ts', start: { line: 2, column: 14 }, precision: 'point' }
  }])
})

test('Doctor severity and off settings override Knip issue filters and rule severities', async () => {
  const root = await project({
    ...findingSources,
    'knip.json': JSON.stringify({
      ...graphConfig,
      include: ['files'],
      exclude: ['exports', 'types', 'duplicates'],
      rules: { files: 'off', exports: 'off', types: 'off', duplicates: 'off' }
    })
  })
  const result = await createDeadCodeRulePack().run(context(root, Object.keys(findingSources), {
    'dead-code/unused-file': 'error',
    'dead-code/unused-export': 'info',
    'dead-code/unused-type': 'off'
  }))

  expect(result.skippedChecks).toEqual([])
  expect(statuses(result)).toEqual({
    'dead-code/unused-file': 'checked',
    'dead-code/unused-export': 'checked',
    'dead-code/unused-type': 'disabled',
    'dead-code/duplicate-export': 'checked'
  })
  expect(result.diagnostics).toHaveLength(3)
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'dead-code/unused-file', severity: 'error', file: 'src/orphan.ts' }),
    expect.objectContaining({ code: 'dead-code/unused-export', severity: 'info', file: 'src/library.ts' }),
    expect.objectContaining({ code: 'dead-code/duplicate-export', severity: 'warning', file: 'src/library.ts' })
  ]))
})

test('all-off rules and empty authoritative targets never execute project configuration', async () => {
  const root = await project({
    ...findingSources,
    'throwing.config.mjs': `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./config-executed', import.meta.url), 'executed')
throw new Error('project configuration must not execute')
export default {}
`
  })
  const pack = createDeadCodeRulePack({ configFile: 'throwing.config.mjs' })
  const allOff = await pack.run(context(
    root,
    Object.keys(findingSources),
    Object.fromEntries(ruleCodes.map(code => [code, 'off' as const]))
  ))

  expect(allOff.diagnostics).toEqual([])
  expect(allOff.skippedChecks).toEqual([])
  expect(statuses(allOff)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'disabled'])))

  const empty = context(root, [], { 'dead-code/unused-type': 'off' })
  empty.source.files = [join(root, 'src/library.ts')]
  const noTargets = await pack.run(empty)

  expect(noTargets.diagnostics).toEqual([])
  expect(noTargets.skippedChecks).toEqual([])
  expect(statuses(noTargets)).toEqual({
    'dead-code/unused-file': 'not-applicable',
    'dead-code/unused-export': 'not-applicable',
    'dead-code/unused-type': 'disabled',
    'dead-code/duplicate-export': 'not-applicable'
  })
  await expect(access(join(root, 'config-executed'))).rejects.toMatchObject({ code: 'ENOENT' })
})

const incompleteProjects: Array<{ name: string; files: Record<string, string> }> = [
  { name: 'invalid Knip configuration', files: { 'knip.json': '{ invalid JSON' } },
  {
    name: 'an unresolved local import outside the selected files even when Knip disables unresolved issues',
    files: {
      'src/entry.ts': `${findingSources['src/entry.ts']}import './missing.ts'\n`,
      'knip.json': JSON.stringify({ ...graphConfig, exclude: ['unresolved'], rules: { unresolved: 'off' } })
    }
  },
  {
    name: 'an entry pattern matching no files',
    files: {
      'knip.json': JSON.stringify({ ...graphConfig, entry: ['src/entry.ts', 'src/missing-entry.ts'] })
    }
  }
]

test.each(incompleteProjects)('invalidates active checks for $name instead of emitting partial findings', async ({ files }) => {
  const root = await project({ ...findingSources, ...files })
  const result = await createDeadCodeRulePack().run(context(root, ['src/library.ts'], {
    'dead-code/unused-type': 'off'
  }))

  expect(result.diagnostics).toEqual([])
  expect(statuses(result)).toEqual({
    'dead-code/unused-file': 'unavailable',
    'dead-code/unused-export': 'unavailable',
    'dead-code/unused-type': 'disabled',
    'dead-code/duplicate-export': 'unavailable'
  })
  expect(result.skippedChecks.map(({ ruleCode, required, reason }) => ({ ruleCode, required, reason }))).toEqual([
    { ruleCode: 'dead-code/unused-file', required: true, reason: 'missing-capability' },
    { ruleCode: 'dead-code/unused-export', required: true, reason: 'missing-capability' },
    { ruleCode: 'dead-code/duplicate-export', required: true, reason: 'missing-capability' }
  ])
})

test('respects project ignores and reloads changed source and imported config helpers on repeated runs', async () => {
  const root = await project({
    'src/entry.ts': "import { used } from './library.ts'\nconsole.log(used)\n",
    'src/library.ts': 'export const used = 1\nexport const unused = 2\n',
    'src/orphan.ts': 'export const orphan = true\n',
    'analysis.config.mjs': `import { ignored } from './analysis-options.mjs'
export default { entry: ['src/entry.ts'], project: ['src/**/*.ts'], ignore: ignored }
`,
    'analysis-options.mjs': "export const ignored = ['src/orphan.ts']\n"
  })
  const pack = createDeadCodeRulePack({ configFile: 'analysis.config.mjs' })
  const selected = context(root, ['src/entry.ts', 'src/library.ts', 'src/orphan.ts'])
  const first = await pack.run(selected)

  expect(first.skippedChecks).toEqual([])
  expect(first.diagnostics).toMatchObject([{ code: 'dead-code/unused-export', file: 'src/library.ts' }])

  await writeFile(join(root, 'src/entry.ts'), "import { used, unused } from './library.ts'\nconsole.log(used, unused)\n")
  const changedSource = await pack.run(selected)

  expect(changedSource.skippedChecks).toEqual([])
  expect(changedSource.diagnostics).toEqual([])

  await writeFile(join(root, 'analysis-options.mjs'), 'export const ignored = []\n')
  const changedConfig = await pack.run(selected)

  expect(changedConfig.skippedChecks).toEqual([])
  expect(changedConfig.diagnostics).toMatchObject([{ code: 'dead-code/unused-file', file: 'src/orphan.ts' }])
})

test('ignored top-level workspace graph inputs remain incomplete until configured on their workspace', async () => {
  const workspaces = {
    '.': { entry: ['src/entry.ts'], project: ['src/**/*.ts'] },
    'packages/child': { entry: ['index.ts'], project: ['**/*.ts'] }
  }
  const root = await project({
    'package.json': JSON.stringify({ name: 'workspace-fixture', private: true, type: 'module', workspaces: ['packages/*'] }),
    'knip.json': JSON.stringify({
      entry: ['extra/intended-entry.ts'], project: ['extra/**/*.ts'], workspaces
    }),
    'src/entry.ts': 'export const publicEntry = 1\n',
    'extra/intended-entry.ts': 'export const publicExtra = 1\n',
    'extra/overlooked.ts': 'export const overlooked = 2\n',
    'packages/child/package.json': JSON.stringify({ name: 'child-fixture', private: true, type: 'module' }),
    'packages/child/index.ts': 'export const publicChild = 1\n'
  })
  const pack = createDeadCodeRulePack()
  const selected = context(root, ['extra/intended-entry.ts', 'extra/overlooked.ts'])
  const ignored = await pack.run(selected)
  expect(ignored.diagnostics).toEqual([])
  expect(statuses(ignored)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'unavailable'])))
  expect(ignored.skippedChecks.map(skip => [skip.ruleCode, skip.required]))
    .toEqual(ruleCodes.map(code => [code, true]))

  await writeFile(join(root, 'knip.json'), JSON.stringify({
    workspaces: {
      ...workspaces,
      '.': { entry: ['src/entry.ts', 'extra/intended-entry.ts'], project: ['src/**/*.ts', 'extra/**/*.ts'] }
    }
  }))
  const corrected = await pack.run(selected)
  expect(corrected.skippedChecks).toEqual([])
  expect(statuses(corrected)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'checked'])))
  expect(corrected.diagnostics).toMatchObject([{
    code: 'dead-code/unused-file', file: 'extra/overlooked.ts'
  }])
})

test('a timeout releases stderr inherited by a longer-lived config helper', async () => {
  const root = await project({
    'src/entry.ts': 'export const publicEntry = 1\n',
    'hanging.config.mjs': `import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const helper = spawn(process.execPath, [
  '--eval',
  "const fs = require('node:fs'); fs.writeFileSync(process.argv[1] + '.tmp', String(process.pid)); fs.renameSync(process.argv[1] + '.tmp', process.argv[1]); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
  fileURLToPath(new URL('./helper.pid', import.meta.url))
], { stdio: ['ignore', 'ignore', 'inherit'] })
helper.unref()
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
export default { entry: ['src/entry.ts'], project: ['src/**/*.ts'] }
`
  })
  const readiness = new AbortController()
  const ready = (async () => {
    for await (const event of watch(root, { signal: readiness.signal })) {
      if (event.filename === 'helper.pid') return Number(await readFile(join(root, 'helper.pid'), 'utf8'))
    }
    throw new Error('The config helper did not signal readiness.')
  })()
  // Wait for the real inherited pipe, then drive only the parent deadline deterministically.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settled = false
  let helperPid: number | undefined
  const pending = Promise.resolve(createDeadCodeRulePack({
    configFile: 'hanging.config.mjs', timeoutMs: 1500
  }).run(context(root, ['src/entry.ts']))).then(result => {
    settled = true
    return result
  })
  try {
    helperPid = await Promise.race([
      ready,
      pending.then(() => { throw new Error('Analysis completed before the config helper was ready.') })
    ])
    await vi.advanceTimersByTimeAsync(1500)
    expect(settled).toBe(true)
    const result = await pending
    expect(result.diagnostics).toEqual([])
    expect(statuses(result)).toEqual(Object.fromEntries(ruleCodes.map(code => [code, 'unavailable'])))
    expect(result.skippedChecks.map(skip => [skip.ruleCode, skip.required]))
      .toEqual(ruleCodes.map(code => [code, true]))
  } finally {
    readiness.abort()
    if (helperPid) {
      try { process.kill(helperPid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await vi.runOnlyPendingTimersAsync()
    await pending
    vi.useRealTimers()
  }
})
