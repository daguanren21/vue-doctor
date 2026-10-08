import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { analyzeSourceText, createSourceDocument, listSourceFiles, parseVueSource, readSourceDocuments } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-documents-'))
  roots.push(root)
  return root
}

describe('requested source documents', () => {
  test.each([
    ['<script>const value = 1', 'script'],
    ['<script setup>const value = 1', 'script-setup'],
    ['<script>const first = 1</script><script>const second = 2</script>', 'script']
  ])('preserves SFC structural failures in parsed and prepared documents: %s', (text, block) => {
    const parsed = parseVueSource(text, 'App.vue')
    const expected = expect.arrayContaining([expect.objectContaining({ block, message: expect.any(String) })])
    expect(parsed.document.structuralFailures).toEqual(expected)
    expect(createSourceDocument('App.vue', text, parsed).structuralFailures).toEqual(expected)
    expect(analyzeSourceText('App.vue', text).preparedDocument.structuralFailures).toEqual(expected)
  })

  test('keeps ordinary script parser errors separate from SFC structural failures', () => {
    const document = createSourceDocument('App.vue', '<script setup lang="ts">const = invalid</script><template><div /></template>')
    expect(document.errors.length).toBeGreaterThan(0)
    expect(document.structuralFailures).toBeUndefined()
  })

  test('retains template attribution for every descriptor error in the same block', () => {
    const document = createSourceDocument('App.vue', '<template><div></span></template><script>const value = 1</script>')
    expect(document.structuralFailures?.length).toBeGreaterThan(1)
    expect(document.structuralFailures?.every(failure => failure.block === 'template')).toBe(true)
  })

  test('keeps unscoped, scoped, external and empty styles with original offsets and attributes', async () => {
    const root = await project()
    const text = '<script setup lang="ts">const value = 1</script>\r\n<template><div /></template>\r\n<style lang="scss" scoped>\r\n.x { color: red; }\r\n</style>\r\n<style src="./external.css"></style>\r\n<style></style>'
    await writeFile(join(root, 'App.vue'), text)
    const [document] = await readSourceDocuments(root)
    expect(document?.blocks.map((block) => block.kind)).toEqual(['script', 'template', 'style', 'style', 'style'])
    expect(document?.blocks[0]?.attributes).toMatchObject({ setup: true, lang: 'ts' })
    expect(document?.blocks[2]).toMatchObject({ lang: 'scss', loc: { line: 3, column: 27 }, attributes: { scoped: true, lang: 'scss' } })
    for (const block of document?.blocks ?? []) expect(text.slice(block.start, block.end)).toBe(block.content)
    expect(document?.errors).toEqual([expect.objectContaining({ message: 'External style source is unavailable: ./external.css' })])
  })

  test('adds requested document extensions without changing default source discovery', async () => {
    const root = await project()
    for (const extension of ['vue', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'html', 'css', 'scss', 'sass']) {
      await writeFile(join(root, `source.${extension}`), extension === 'vue' ? '<template><div /></template>' : '')
    }
    const defaultFiles = await listSourceFiles(root)
    expect(defaultFiles.map((file) => file.slice(file.lastIndexOf('.') + 1))).toEqual(['cjs', 'js', 'mjs', 'ts', 'tsx', 'vue'])
    const documents = await readSourceDocuments(root, { extensions: ['.jsx', '.mts', '.cts', '.html', '.css', '.scss', '.sass'] })
    expect(documents.map((document) => document.language)).toEqual(['cjs', 'css', 'cts', 'html', 'js', 'jsx', 'mjs', 'mts', 'sass', 'scss', 'ts', 'tsx', 'vue'])
    expect(documents.find((document) => document.language === 'css')?.blocks).toEqual([{ kind: 'document', lang: 'css', content: '', start: 0, end: 0, loc: { line: 1, column: 1 }, attributes: {} }])
  })

  test('applies an exact file allowlist after discovering custom document extensions', async () => {
    const root = await project()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'other'))
    const cssFile = join(root, 'src', 'theme.css')
    const htmlFile = join(root, 'src', 'shell.html')
    await writeFile(cssFile, '.theme {}')
    await writeFile(htmlFile, '<main></main>')
    await writeFile(join(root, 'src', 'App.vue'), '<template><div /></template>')
    await writeFile(join(root, 'other', 'ignored.css'), '.ignored {}')

    const documents = await readSourceDocuments(root, {
      scope: ['src', 'other'],
      files: ['src/theme.css', htmlFile, 'other/missing.html'],
      extensions: ['.css', '.html']
    })

    expect(documents.map((document) => document.file)).toEqual([htmlFile, cssFile])
  })

  test('rejects outside scopes, ignored scopes and scoped symlink escapes', async () => {
    const root = await project()
    const outside = await project()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'valid.css'), '.x {}')
    await writeFile(join(root, 'node_modules', 'ignored.css'), '.x {}')
    await writeFile(join(outside, 'outside.css'), '.x {}')
    await symlink(outside, join(root, 'escape'))
    await symlink(join(root, 'node_modules'), join(root, 'ignored-link'))
    await symlink(join(outside, 'outside.css'), join(root, 'escape.css'))
    const documents = await readSourceDocuments(root, { extensions: ['.css'], scope: ['src', 'src/valid.css', 'node_modules', outside, 'escape', 'escape.css', 'ignored-link'] })
    expect(documents.map((document) => document.file)).toEqual([join(root, 'src', 'valid.css')])
  })

  test('records invalid script syntax and invalid UTF-8 rather than silently treating files as checked', async () => {
    const root = await project()
    await writeFile(join(root, 'bad.ts'), 'const = broken')
    await writeFile(join(root, 'bad.css'), Buffer.from([0xff, 0xfe]))
    const documents = await readSourceDocuments(root, { extensions: ['.css'] })
    expect(documents.find((document) => document.language === 'ts')?.errors).toEqual([expect.objectContaining({ message: expect.any(String), line: 1 })])
    expect(documents.find((document) => document.language === 'css')?.textUnavailable).toBe('invalid-encoding')
  })

  test('retains failed or absent snapshot entries even when disk content is readable', async () => {
    const root = await project()
    const failed = join(root, 'failed.md')
    const absent = join(root, 'absent.md')
    await Promise.all([writeFile(failed, 'debugger'), writeFile(absent, 'debugger')])
    const documents = await readSourceDocuments(root, {
      targetFiles: { root, files: [failed, absent], issues: [] },
      sourceTexts: new Map(),
      readFailures: new Map([[failed, new Error('Snapshot permission denied')]])
    })
    expect(documents).toMatchObject([
      { file: failed, text: '', textUnavailable: 'read-failed', errors: [{ message: 'Snapshot permission denied' }] },
      { file: absent, text: '', textUnavailable: 'read-failed', errors: [{ message: expect.any(String) }] }
    ])
  })

  test('keeps parser boundaries independent and reports external script/template sources as unavailable', async () => {
    const parsed = parseVueSource('<template src="./template.html"></template><script src="./script.js"></script><style>.x {}</style>', 'App.vue')
    expect(parsed.blocks).toEqual([
      { kind: 'template', status: 'failed', message: 'External template source is unavailable: ./template.html' },
      { kind: 'script', status: 'failed', message: 'External script source is unavailable: ./script.js' },
      { kind: 'script-setup', status: 'absent' }
    ])
    expect(parsed.templateAst).toBeUndefined()
    expect(parsed.scriptPrograms).toEqual([])
    const root = await project()
    await writeFile(join(root, 'App.vue'), '<script setup lang="ts">const = broken</script><template><Field /></template><style>.x { color: red }</style>')
    const [document] = await readSourceDocuments(root)
    expect(document?.blocks.find((block) => block.kind === 'style')?.content).toBe('.x { color: red }')
    expect(document?.errors).toEqual([expect.objectContaining({ message: expect.any(String) })])
  })

  test('retains sorted results and per-file failures across multiple reader batches', async () => {
    const root = await project()
    const names = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, '0')}.ts`)
    await Promise.all(names.map((name, index) => writeFile(join(root, name), index === 19 ? 'const = broken' : `export const index = ${index}`)))
    const documents = await readSourceDocuments(root)
    expect(documents.map((document) => document.file)).toEqual(names.map((name) => join(root, name)))
    expect(documents.filter((document) => document.errors.length > 0).map((document) => document.file)).toEqual([join(root, '19.ts')])
    expect(documents[39]?.blocks[0]?.content).toBe('export const index = 39')
  })
})
