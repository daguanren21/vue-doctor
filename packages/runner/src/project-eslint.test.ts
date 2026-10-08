import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { resolveDoctorRuleCatalogs, runDoctor } from './run.js'
import { createDoctorAnalysisSession } from './session.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-project-eslint-'))
  roots.push(root)
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(await realpath(join(import.meta.dirname, '../../rules-eslint/node_modules/eslint')), join(root, 'node_modules/eslint'), 'dir')
  await symlink(await realpath(join(import.meta.dirname, '../../rules-eslint/node_modules/vue-eslint-parser')), join(root, 'node_modules/vue-eslint-parser'), 'dir')
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { vue: '^3.5.0' }, devDependencies: { eslint: '*' } }))
  await writeFile(join(root, 'eslint.config.mjs'), config)
  return root
}

test('auto mode runs project rules with per-file severity and exposes dynamic metadata', async () => {
  const root = await project(`
const custom = { rules: { marker: {
  meta: { docs: { description: 'Project marker documentation', url: 'https://example.test/marker' } },
  create(context) { return { Program(node) { context.report({ node, message: 'marker' }) } } }
} } }
export default [
  { files: ['**/*.js'], plugins: { custom }, rules: { 'custom/marker': 'warn', 'no-debugger': 'warn' } },
  { files: ['strict.js'], rules: { 'no-debugger': 'error' } }
]
`)
  await Promise.all([
    writeFile(join(root, 'normal.js'), 'debugger'),
    writeFile(join(root, 'strict.js'), 'debugger')
  ])
  const report = await runDoctor({ root, config: { gitAttribution: false } })
  expect(report.diagnostics.filter(item => item.code === 'eslint/no-debugger').map(item => item.severity)).toEqual(['warning', 'error'])
  expect(report.ruleCatalogs?.[0]?.rules.find(rule => rule.code === 'eslint/custom/marker')).toMatchObject({
    title: 'Project marker documentation',
    description: 'Project marker documentation'
  })
  expect(report.checks?.find(check => check.ruleCode === 'eslint/no-debugger')).toMatchObject({ status: 'checked', files: 2 })
  const catalogs = await resolveDoctorRuleCatalogs({ root })
  expect(catalogs.find(catalog => catalog.name === 'eslint')?.rules.some(rule => rule.code === 'eslint/custom/marker')).toBe(true)
})

test('builtin and off modes do not evaluate project config', async () => {
  const root = await project(`throw new Error('must not load')`)
  await writeFile(join(root, 'sample.js'), 'debugger')
  const builtin = await runDoctor({ root, config: {
    gitAttribution: false,
    eslint: { mode: 'builtin' },
    rules: { 'eslint/no-debugger': 'warning' }
  } })
  expect(builtin.diagnostics.some(item => item.code === 'eslint/no-debugger')).toBe(true)
  const off = await runDoctor({ root, config: { gitAttribution: false, eslint: { mode: 'off' } } })
  expect(off.diagnostics.some(item => item.code.startsWith('eslint/'))).toBe(false)
  await expect(runDoctor({ root, config: { eslint: { mode: 'auto' } } })).rejects.toThrow('must not load')
})

test('zero files validates config and catalogs rules without executing them', async () => {
  const root = await project(`
const custom = { rules: { never: {
  meta: { docs: { description: 'Never execute rule' } },
  create() { throw new Error('rule executed') }
} } }
export default [{ plugins: { custom }, rules: { 'custom/never': 'error' } }]
`)
  const report = await runDoctor({ root, files: [], config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.diagnostics).toEqual([])
  expect(report.ruleCatalogs?.[0]?.rules.some(rule => rule.code === 'eslint/custom/never')).toBe(true)
  expect(report.checks?.find(check => check.ruleCode === 'eslint/custom/never')).toMatchObject({ status: 'not-applicable', files: 0 })
})

test('project ignores, processors and parser failures preserve target and coverage semantics', async () => {
  const root = await project(`
const markdown = {
  preprocess(text) { return [{ text, filename: 'block.js' }] },
  postprocess(lists) { return lists.flat() }
}
const broken = { parse() { throw new Error('typed parser unavailable') } }
export default [
  { ignores: ['ignored.js'] },
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], rules: { 'no-debugger': 'error' } },
  { files: ['broken.ts'], languageOptions: { parser: broken }, rules: { 'no-debugger': 'error' } }
]
`)
  await Promise.all([
    writeFile(join(root, 'sample.md'), 'debugger'),
    writeFile(join(root, 'ignored.js'), 'debugger'),
    writeFile(join(root, 'broken.ts'), 'debugger')
  ])
  const report = await runDoctor({ root, config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.diagnostics.filter(item => item.code === 'eslint/no-debugger')).toHaveLength(1)
  expect(report.diagnostics[0]?.file).toBe('sample.md')
  expect(report.skippedChecks).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleCode: 'eslint/no-debugger', file: 'broken.ts', required: true, reason: 'parse-failed' })
  ]))
  expect(report.coverage.status).toBe('partial')
  expect(report.run?.target.files).not.toContain(join(root, 'ignored.js'))
})

test('rejects unknown rules, host-disabled activation and unsafe scopes without widening', async () => {
  const root = await project(`export default [{ rules: { 'no-debugger': 'off' } }]`)
  await writeFile(join(root, 'sample.js'), 'debugger')
  await expect(runDoctor({ root, config: { rules: { 'eslint/misspelled': 'off' } } })).rejects.toThrow('eslint/misspelled')
  await expect(runDoctor({ root, config: { rules: { 'eslint/no-debugger': 'warning' } } })).rejects.toThrow('cannot enable')
  const report = await runDoctor({ root, scope: '..', config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.run?.target.files).toEqual([])
  expect(report.diagnostics).toEqual([])
})

test('intersects explicit JavaScript and processor targets with the validated scope', async () => {
  const root = await project(`
const json = {
  preprocess() { return [{ text: 'debugger', filename: 'block.js' }] },
  postprocess(lists) { return lists.flat() }
}
export default [
  { files: ['**/*.json'], processor: json },
  { files: ['**/*.json/*.js'], rules: { 'no-debugger': 'error' } },
  { files: ['**/*.js'], rules: { 'no-debugger': 'error' } }
]
`)
  await mkdir(join(root, 'src'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'src', 'inside.js'), 'debugger'),
    writeFile(join(root, 'src', 'inside.json'), '{}'),
    writeFile(join(root, 'outside.js'), 'debugger'),
    writeFile(join(root, 'outside.json'), '{}')
  ])

  const report = await runDoctor({
    root,
    scope: 'src',
    files: ['src/inside.js', 'src/inside.json', 'outside.js', 'outside.json'],
    config: { gitAttribution: false, eslint: { mode: 'project' } }
  })

  expect(report.run?.target.files).toEqual(['src/inside.js', 'src/inside.json'])
  expect(report.diagnostics.filter(item => item.code === 'eslint/no-debugger').map(item => item.file)).toEqual([
    'src/inside.js',
    'src/inside.json'
  ])
})

test('does not lint requested files when every supplied scope is invalid', async () => {
  const root = await project(`export default [{ files: ['**/*.js'], rules: { 'no-debugger': 'error' } }]`)
  await writeFile(join(root, 'sample.js'), 'debugger')

  const report = await runDoctor({
    root,
    scope: ['missing', '..'],
    files: ['sample.js'],
    config: { gitAttribution: false, eslint: { mode: 'project' } }
  })

  expect(report.run?.target.files).toEqual([])
  expect(report.diagnostics.some(item => item.code === 'eslint/no-debugger')).toBe(false)
})

test('uses the nearest package config and local ESLint session for processor-only monorepo targets', async () => {
  const root = await project(`export default []`)
  const child = join(root, 'packages', 'docs')
  await mkdir(child, { recursive: true })
  await writeFile(join(child, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { eslint: '*' } }))
  await writeFile(join(child, 'eslint.config.mjs'), `
const markdown = { preprocess(text) { return [{ text, filename: 'block.js' }] }, postprocess(lists) { return lists.flat() } }
export default [
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], rules: { 'no-debugger': 'error' } }
]
`)
  await writeFile(join(child, 'guide.md'), 'debugger')
  const report = await runDoctor({ root, config: { gitAttribution: false } })
  expect(report.diagnostics).toEqual([
    expect.objectContaining({ code: 'eslint/no-debugger', file: 'packages/docs/guide.md', severity: 'error' })
  ])
  expect(report.projectContext?.packages.some(item => item.root === child)).toBe(true)
})

test('preserves consuming Vue parser behavior for Vue 2.7 and Vue 3 SFCs', async () => {
  const root = await project(`
import vueParser from 'vue-eslint-parser'
export default [{ files: ['**/*.vue'], languageOptions: { parser: vueParser }, rules: { 'no-debugger': 'error' } }]
`)
  const legacy = join(root, 'packages', 'legacy')
  const modern = join(root, 'packages', 'modern')
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(modern, { recursive: true })])
  await Promise.all([
    writeFile(join(legacy, 'package.json'), JSON.stringify({ type: 'module', dependencies: { vue: '^2.7.16' } })),
    writeFile(join(modern, 'package.json'), JSON.stringify({ type: 'module', dependencies: { vue: '^3.5.0' } })),
    writeFile(join(legacy, 'Legacy.vue'), `<script setup>\ndebugger\n</script>`),
    writeFile(join(modern, 'Modern.vue'), `<script setup>\ndebugger\n</script>`)
  ])
  const report = await runDoctor({ root, config: { gitAttribution: false } })
  expect(report.diagnostics.filter(item => item.code === 'eslint/no-debugger').map(item => item.file)).toEqual([
    'packages/legacy/Legacy.vue',
    'packages/modern/Modern.vue'
  ])
})

test('lets native lookup find a scoped nested config and keeps hard-ignored or escaped files out', async () => {
  const root = await project(`export default []`)
  await unlink(join(root, 'eslint.config.mjs'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'eslint.config.mjs'), `export default [{ rules: { 'no-debugger': 'error' } }]`)
  await writeFile(join(root, 'src', 'app.js'), 'debugger')
  await mkdir(join(root, 'src', 'dist'), { recursive: true })
  await writeFile(join(root, 'src', 'dist', 'ignored.js'), 'debugger')
  const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-eslint-outside-'))
  roots.push(outside)
  await writeFile(join(outside, 'escaped.js'), 'debugger')
  await symlink(outside, join(root, 'src', 'linked'), 'dir')

  const report = await runDoctor({ root, scope: 'src', config: { gitAttribution: false } })
  expect(report.diagnostics.filter(item => item.code === 'eslint/no-debugger')).toEqual([
    expect.objectContaining({ file: 'src/app.js' })
  ])
  expect(report.run?.target.files.some(file => file.includes('/dist/') || file.includes('/linked/'))).toBe(false)
})

test('reports engine failures and null-rule messages even when the project config enables no rules', async () => {
  const root = await project(`
const broken = { parse() { throw new Error('parser exploded') } }
export default [
  { files: ['broken.js'], languageOptions: { parser: broken } },
  { files: ['directive.js'], linterOptions: { reportUnusedDisableDirectives: 'warn' } }
]
`)
  await Promise.all([
    writeFile(join(root, 'broken.js'), 'const value = 1'),
    writeFile(join(root, 'directive.js'), '/* eslint-disable no-alert */\nconst value = 1')
  ])
  const report = await runDoctor({ root, config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.skippedChecks).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleCode: 'eslint/project-analysis', file: 'broken.js', required: true, reason: 'parse-failed' })
  ]))
  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'eslint/project-analysis', file: 'directive.js', severity: 'warning' })
  ]))
  expect(report.coverage.status).toBe('partial')
})

test('preserves snapshot read failures for processor targets instead of retrying disk', async () => {
  const root = await project(`
const markdown = { preprocess(text) { return [{ text, filename: 'block.js' }] }, postprocess(lists) { return lists.flat() } }
export default [
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], rules: { 'no-debugger': 'error' } }
]
`)
  await writeFile(join(root, 'sample.md'), 'debugger')
  const session = createDoctorAnalysisSession({
    root, files: ['sample.md'], config: { gitAttribution: false, eslint: { mode: 'project' } }
  }, {
    sourceWorkspaceOptions: { readSource: async () => { throw new Error('Snapshot read denied') } }
  })
  try {
    const report = await session.run()
    expect(report.diagnostics).toEqual([])
    expect(report.coverage.status).toBe('partial')
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'eslint/project-analysis', file: 'sample.md', required: true, reason: 'missing-capability'
    }))
    expect(report.checks).toContainEqual(expect.objectContaining({
      ruleCode: 'eslint/project-analysis', status: 'unavailable', reason: expect.stringContaining('Snapshot read denied')
    }))
  } finally {
    await session.close()
  }
})

test('prepares processor rule catalogs from the same snapshot used by formal analysis', async () => {
  const root = await project(`
const markdown = {
  preprocess(text) { return [{ text: text.slice(3), filename: text.startsWith('TS:') ? 'block.ts' : 'block.js' }] },
  postprocess(lists) { return lists.flat() }
}
export default [
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], rules: { 'no-debugger': 'error' } },
  { files: ['**/*.md/*.ts'], rules: { 'no-alert': 'error' } }
]
`)
  await writeFile(join(root, 'sample.md'), 'JS:debugger')
  let source = 'TS:alert("snapshot")'
  const session = createDoctorAnalysisSession({
    root, files: ['sample.md'], config: { gitAttribution: false, eslint: { mode: 'project' } }
  }, {
    sourceWorkspaceOptions: {
      readSource: async file => file.endsWith('sample.md') ? source : readFile(file)
    }
  })
  try {
    const first = await session.run()
    expect(first.diagnostics.filter(item => item.code.startsWith('eslint/'))).toEqual([
      expect.objectContaining({ code: 'eslint/no-alert', file: 'sample.md', severity: 'error' })
    ])
    expect(first.ruleCatalogs?.[0]?.rules.map(rule => rule.code)).toContain('eslint/no-alert')
    expect(first.ruleCatalogs?.[0]?.rules.map(rule => rule.code)).not.toContain('eslint/no-debugger')
    expect(first.checks).toContainEqual(expect.objectContaining({ ruleCode: 'eslint/no-alert', status: 'checked', files: 1 }))
    source = 'JS:debugger'
    session.invalidate(join(root, 'sample.md'))
    const second = await session.run()
    expect(second.diagnostics.filter(item => item.code.startsWith('eslint/'))).toEqual([
      expect.objectContaining({ code: 'eslint/no-debugger', file: 'sample.md', severity: 'error' })
    ])
    expect(second.ruleCatalogs?.[0]?.rules.map(rule => rule.code)).not.toContain('eslint/no-alert')
  } finally {
    await session.close()
  }
})

test('analyzes extensionless files explicitly selected by project ESLint', async () => {
  const root = await project(`export default [{ files: ['bin/tool'], rules: { 'no-debugger': 'error' } }]`)
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/tool'), '#!/usr/bin/env node\ndebugger')
  const report = await runDoctor({ root, files: ['bin/tool'], config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.run?.target.files).toEqual(['bin/tool'])
  expect(report.diagnostics.filter(item => item.code.startsWith('eslint/'))).toEqual([
    expect.objectContaining({ code: 'eslint/no-debugger', file: 'bin/tool', severity: 'error' })
  ])
  expect(report.skippedChecks?.filter(item => item.ruleCode.startsWith('eslint/'))).toEqual([])
  expect(report.checks).toContainEqual(expect.objectContaining({ ruleCode: 'eslint/no-debugger', files: 1, status: 'checked' }))
})

test('keeps quiet virtual-rule documentation in reports and independently resolved catalogs', async () => {
  const root = await project(`
const quiet = {
  meta: { docs: { description: 'Virtual-only rule documentation', url: 'https://example.test/virtual-quiet' } },
  create() { return {} }
}
const markdown = {
  preprocess(text) { return [{ text, filename: 'block.js' }] },
  postprocess(lists) { return lists.flat() }
}
export default [
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], plugins: { custom: { rules: { quiet } } }, rules: { 'custom/quiet': 'warn' } }
]
`)
  await writeFile(join(root, 'sample.md'), 'const value = 1')
  const options = { root, files: ['sample.md'], config: { gitAttribution: false } }
  const report = await runDoctor(options)
  const catalogs = await resolveDoctorRuleCatalogs(options)
  const metadata = {
    code: 'eslint/custom/quiet',
    title: 'Virtual-only rule documentation',
    description: 'Virtual-only rule documentation',
    help: expect.objectContaining({ remediation: expect.stringContaining('https://example.test/virtual-quiet') })
  }
  expect(report.diagnostics).toEqual([])
  expect(report.ruleCatalogs?.[0]?.rules).toContainEqual(expect.objectContaining(metadata))
  expect(catalogs.find(catalog => catalog.name === 'eslint')?.rules).toContainEqual(expect.objectContaining(metadata))
})

test('preserves ESLint diagnostics for unavailable rules referenced by inline directives', async () => {
  const root = await project(`export default [{ rules: { 'no-debugger': 'error' } }]`)
  await writeFile(join(root, 'sample.js'), '// eslint-disable-next-line removed/rule\ndebugger')
  const report = await runDoctor({ root, files: ['sample.js'], config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.diagnostics.filter(item => item.code.startsWith('eslint/'))).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'eslint/removed/rule', file: 'sample.js', severity: 'error', message: expect.stringContaining('removed/rule') }),
    expect.objectContaining({ code: 'eslint/no-debugger', file: 'sample.js', severity: 'error' })
  ]))
  expect(report.ruleCatalogs?.[0]?.rules.map(rule => rule.code)).toContain('eslint/removed/rule')
})

test('lets the project ESLint engine analyze readable empty Vue documents', async () => {
  const root = await project(`export default [{
    files: ['**/*.vue'],
    plugins: { probe: { rules: { readable: {
      meta: { schema: [] },
      create(context) { return { Program(node) { context.report({ node, message: 'The empty snapshot was analyzed.' }) } } }
    } } } },
    rules: { 'probe/readable': 'error' }
  }]`)
  await writeFile(join(root, 'empty.vue'), '')
  const report = await runDoctor({ root, files: ['empty.vue'], config: { gitAttribution: false, eslint: { mode: 'project' } } })
  expect(report.diagnostics).toContainEqual(expect.objectContaining({
    code: 'eslint/probe/readable', file: 'empty.vue', message: 'The empty snapshot was analyzed.'
  }))
  expect(report.skippedChecks?.filter(item => item.ruleCode.startsWith('eslint/'))).toEqual([])
})
