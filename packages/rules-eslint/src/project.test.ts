import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createProjectEslintSession, findProjectEslintConfig } from './project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-project-eslint-'))
  roots.push(root)
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(await realpath(join(import.meta.dirname, '../node_modules/eslint')), join(root, 'node_modules/eslint'), 'dir')
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { eslint: '*' } }))
  await writeFile(join(root, 'eslint.config.mjs'), config)
  return root
}

test('uses project flat config, per-file severity, ignores and snapshot text in an isolated process', async () => {
  const root = await project(`
console.log('config stdout must stay isolated')
const custom = { rules: { marker: {
  meta: { docs: { description: 'Project marker rule', url: 'https://example.test/marker' } },
  create(context) { return { Program(node) { if (context.sourceCode.text.includes('MARK')) context.report({ node, message: 'marked' }) } } }
} } }
export default [
  { ignores: ['ignored.js'] },
  { files: ['**/*.js'], plugins: { custom }, rules: { 'custom/marker': 'warn', 'no-debugger': 'off' } },
  { files: ['strict.js'], rules: { 'custom/marker': 'error' } }
]
`)
  await Promise.all([
    writeFile(join(root, 'normal.js'), 'disk text'),
    writeFile(join(root, 'strict.js'), 'disk text'),
    writeFile(join(root, 'ignored.js'), 'MARK')
  ])
  const configFile = await findProjectEslintConfig({ root })
  expect(configFile).toBe(join(root, 'eslint.config.mjs'))
  const session = await createProjectEslintSession({ root })
  try {
    const files = await session.discover(['.'])
    const prepared = await session.prepare(files.map(filePath => ({ filePath, text: 'MARK' })))
    expect(prepared.files.map(file => file.filePath)).toEqual(expect.arrayContaining([join(root, 'normal.js'), join(root, 'strict.js')]))
    expect(prepared.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom/marker', severity: 2, title: 'Project marker rule' }),
      expect.objectContaining({ ruleId: 'no-debugger', severity: 0 })
    ]))
    expect(prepared.files.find(file => file.filePath.endsWith('strict.js'))?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom/marker', severity: 2 })
    ]))
    const results = await session.lint([
      { filePath: join(root, 'normal.js'), text: 'MARK' },
      { filePath: join(root, 'strict.js'), text: 'MARK' }
    ])
    expect(results.map(result => result.messages.map(message => [message.ruleId, message.severity]))).toEqual([
      [['custom/marker', 1]],
      [['custom/marker', 2]]
    ])
  } finally {
    await session.dispose()
  }
})

test('reloads imported config helpers in a fresh generation process and rejects invalid config', async () => {
  const root = await project(`
import { description } from './eslint-helper.mjs'
const custom = { rules: { marker: { meta: { docs: { description } }, create() { return {} } } } }
export default [{ plugins: { custom }, rules: { 'custom/marker': 'warn' } }]
`)
  await writeFile(join(root, 'eslint-helper.mjs'), `export const description = 'first generation'`)
  const first = await createProjectEslintSession({ root })
  expect((await first.prepare([])).rules).toContainEqual(expect.objectContaining({ title: 'first generation' }))
  await first.dispose()
  await writeFile(join(root, 'eslint-helper.mjs'), `export const description = 'second generation'`)
  const second = await createProjectEslintSession({ root })
  expect((await second.prepare([])).rules).toContainEqual(expect.objectContaining({ title: 'second generation' }))
  await second.dispose()

  await writeFile(join(root, 'eslint.config.mjs'), `throw new Error('broken project config')`)
  const broken = await createProjectEslintSession({ root })
  await expect(broken.prepare([])).rejects.toThrow('broken project config')
  await broken.dispose()
})

test('discovers and executes rules selected for processor virtual files', async () => {
  const root = await project(`
const markdown = {
  preprocess(text) { return [{ text, filename: 'block.js' }] },
  postprocess(messageLists) { return messageLists.flat() },
  supportsAutofix: true
}
export default [
  { files: ['**/*.md'], processor: markdown },
  { files: ['**/*.md/*.js'], rules: { 'no-debugger': 'error' } }
]
`)
  await writeFile(join(root, 'sample.md'), 'debugger')
  const session = await createProjectEslintSession({ root })
  try {
    const files = await session.discover(['.'])
    const prepared = await session.prepare(files.map(filePath => ({ filePath, text: 'debugger' })))
    expect(prepared.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: join(root, 'sample.md'),
        rules: expect.arrayContaining([expect.objectContaining({ ruleId: 'no-debugger', severity: 2 })])
      })
    ]))
    const results = await session.lint([{ filePath: join(root, 'sample.md'), text: 'debugger' }])
    expect(results[0]).toEqual(expect.objectContaining({
      rules: expect.arrayContaining([expect.objectContaining({ ruleId: 'no-debugger', severity: 2 })]),
      messages: expect.arrayContaining([expect.objectContaining({ ruleId: 'no-debugger', severity: 2 })])
    }))
  } finally {
    await session.dispose()
  }
})
