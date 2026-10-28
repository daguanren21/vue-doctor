import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { analyzeSourceText, parseVueSource, scanVueSourceUsage } from './index.js'

async function projectWithFile(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-sfc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/App.vue'), content, 'utf8')
  return root
}

describe('independent Vue SFC block analysis', () => {
  test('marks absent script separately from available template', async () => {
    const root = await projectWithFile('<template><FixtureButton /></template>\n')

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual([
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'absent' },
      { kind: 'script-setup', status: 'absent' }
    ])
    expect(result.components.map((component) => component.tag)).toEqual(['FixtureButton'])
  })

  test('keeps template facts when script setup fails', async () => {
    const root = await projectWithFile(
      '<script setup lang="ts">const = broken</script>\n<template><FixtureButton /></template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'available' }),
      expect.objectContaining({ kind: 'script-setup', status: 'failed', message: expect.any(String) })
    ]))
    expect(result.components.map((component) => component.tag)).toEqual(['FixtureButton'])
  })

  test('keeps script imports and plugin registrations when template fails', async () => {
    const root = await projectWithFile(
      '<script>import { createApp } from "vue"; import FixtureUi from "@fixture/ui"; const app = createApp({}); app.use(FixtureUi)</script>\n<template><FixtureButton :value="broken(" /></template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'failed', message: expect.any(String) }),
      expect.objectContaining({ kind: 'script', status: 'available' })
    ]))
    expect(result.globalPlugins).toEqual([expect.objectContaining({
      package: { specifier: '@fixture/ui', packageName: '@fixture/ui' }
    })])
  })

  test('parses Vue 2 and script setup TSX blocks independently', async () => {
    const root = await projectWithFile(
      '<script setup lang="tsx">const render = () => <FixtureIcon /></script>\n<template><FixtureButton /></template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual([
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'absent' },
      { kind: 'script-setup', status: 'available', lang: 'tsx' }
    ])
    expect(result.components.map((component) => component.tag)).toEqual(['FixtureButton'])
  })

  test('parses JSX used in a plain JavaScript block', async () => {
    const root = await projectWithFile(
      '<script>const render = () => <FixtureIcon /></script>\n<template><FixtureButton /></template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual([
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'available' },
      { kind: 'script-setup', status: 'absent' }
    ])
  })

  test('parses a Vue 2 style plain script and template', async () => {
    const root = await projectWithFile(
      '<template><FixtureButton /></template>\n<script>export default { name: "FixtureView" }</script>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual([
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'available' },
      { kind: 'script-setup', status: 'absent' }
    ])
  })

  test('surfaces descriptor-level failures without dropping another block', async () => {
    const root = await projectWithFile(
      '<script>import { createApp } from "vue"; import FixtureUi from "@fixture/ui"; const app = createApp({}); app.use(FixtureUi)</script>\n<template><First /></template><template><Second /></template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'failed', message: expect.stringContaining('only one') }),
      expect.objectContaining({ kind: 'script', status: 'available' })
    ]))
    expect(result.globalPlugins).toHaveLength(1)
  })

  test('maps template locations back to the original SFC', async () => {
    const root = await projectWithFile(
      '<script>const ready = true</script>\n\n<template>\n  <FixtureButton />\n</template>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.components[0]?.loc).toEqual({ line: 4, column: 3 })
  })

  test.each(['limit < 40', 'symbols <>', 'limit <\n', 'limit <= 40', 'heart <3'])(
    'preserves literal less-than text accepted by Vue 2 and Vue 3: %s',
    (text) => {
      const source = `<script>export default {}</script>\n<template>\n  <div>${text}<FixtureButton /></div>\n</template>`
      const result = analyzeSourceText('App.vue', source)

      expect(result.fileResult.blocks).toEqual([
        { kind: 'template', status: 'available' },
        { kind: 'script', status: 'available' },
        { kind: 'script-setup', status: 'absent' }
      ])
      expect(result.parsed?.templateAst).toMatchObject({
        templateBody: {
          children: expect.arrayContaining([
            expect.objectContaining({
              type: 'VElement',
              children: expect.arrayContaining([expect.objectContaining({ type: 'VText', value: text })])
            })
          ])
        }
      })
      expect(result.components).toEqual([
        expect.objectContaining({
          tag: 'FixtureButton',
          loc: text.endsWith('\n')
            ? { line: 4, column: 1 }
            : { line: 3, column: 8 + text.length }
        })
      ])
      expect(result.preparedDocument.errors).toEqual([])
    }
  )

  test.each([
    '</?>',
    '</br>',
    '<FixtureButton class="small"" />',
    '<FixtureButton></FixtureButton></FixtureButton>',
    '<FixtureButton :value="broken(" />'
  ])('does not let literal less-than text hide malformed markup or expressions: %s', (markup) => {
    const source = `<script setup>const value = 1</script>\n<template><div>limit < 40${markup}</div></template>`
    const result = analyzeSourceText('App.vue', source)

    expect(result.fileResult.blocks).toEqual([
      expect.objectContaining({ kind: 'template', status: 'failed', message: expect.any(String) }),
      { kind: 'script', status: 'absent' },
      { kind: 'script-setup', status: 'available' }
    ])
    expect(result.parsed?.templateAst).toBeUndefined()
    expect(result.parsed?.scriptPrograms).toHaveLength(1)
    expect(result.components).toEqual([])
    expect(result.preparedDocument.errors.length).toBeGreaterThan(0)
  })

  test('keeps recovered literal text and component facts when script setup fails', () => {
    const result = analyzeSourceText(
      'App.vue',
      '<script setup lang="ts">const = broken</script>\n<template><div>limit < 40<FixtureButton /></div></template>'
    )

    expect(result.fileResult.blocks).toEqual([
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'absent' },
      expect.objectContaining({ kind: 'script-setup', status: 'failed', lang: 'ts' })
    ])
    expect(result.components.map((component) => component.tag)).toEqual(['FixtureButton'])
    expect(result.parsed?.scriptPrograms).toEqual([])
  })

  test('uses a JavaScript parser for JS blocks and rejects TypeScript syntax', async () => {
    const root = await projectWithFile('<script>const value: string = "x"</script>\n<template><Fixture /></template>\n')

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'script', status: 'failed' }),
      expect.objectContaining({ kind: 'template', status: 'available' })
    ]))
  })

  test('marks malformed and unsupported blocks as failed', async () => {
    const root = await projectWithFile(
      '<template lang="pug">Fixture</template>\n<script lang="coffee">value = 1</script>\n'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual([
      expect.objectContaining({ kind: 'template', status: 'failed', lang: 'pug' }),
      expect.objectContaining({ kind: 'script', status: 'failed', lang: 'coffee' }),
      { kind: 'script-setup', status: 'absent' }
    ])
  })

  test('attributes an unterminated template opening tag to template failure', async () => {
    const root = await projectWithFile('<script>import { createApp } from "vue"; import FixtureUi from "@fixture/ui"; const app = createApp({}); app.use(FixtureUi)</script>\n<template>\n<FixtureButton>\n')

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'failed' }),
      expect.objectContaining({ kind: 'script', status: 'available' })
    ]))
    expect(result.globalPlugins).toHaveLength(1)
  })
  test('maps script ranges and locations back to the original SFC', () => {
    const source = `<template><div /></template>
<script setup>
const value = window.innerWidth
</script>
`
    const parsed = parseVueSource(source, '/project/src/App.vue')
    const program = parsed.scriptPrograms[0] as {
      body?: Array<{
        range?: [number, number]
        loc?: { start: { line: number; column: number } }
      }>
    }
    const declaration = program.body?.[0]

    expect(declaration?.range && source.slice(...declaration.range)).toBe(
      'const value = window.innerWidth'
    )
    expect(declaration?.loc?.start).toEqual({ line: 3, column: 0 })
  })

  test.each([
    ['script', '', '\n'],
    ['script', ' lang="ts"', '\n'],
    ['script setup', '', '\r\n'],
    ['script setup', ' lang="ts"', '\r\n']
  ])('remaps multiline parser errors in %s%s with %j newlines', (tag, attributes, newline) => {
    const source = `<template><div /></template>${newline}<${tag}${attributes}>${newline}const good = 1${newline}const broken = ;${newline}</script>`
    const parsed = parseVueSource(source, 'Fixture.vue')
    const expected = [{ message: expect.any(String), line: 4, column: 16 }]
    expect(parsed.document.errors).toEqual(expected)
    expect(analyzeSourceText('Fixture.vue', source).preparedDocument.errors).toEqual(expected)
    expect(parsed.blocks.find(block => block.kind === 'template')?.status).toBe('available')
  })

  test.each([
    '<script>',
    '<script lang="ts">',
    '<script setup>',
    '<script setup lang="ts">'
  ])('remaps inline first-line script errors after %s', (opening) => {
    const prefix = '<template><div /></template>'
    const source = `${prefix}${opening}const broken = ;</script>`
    expect(parseVueSource(source, 'Fixture.vue').document.errors).toEqual([
      { message: expect.any(String), line: 1, column: source.indexOf(';') + 1 }
    ])
  })

  test.each([
    ['<template>', '', '<div v-for="item of"></div>'],
    ['<template lang="html">', '\n', '<div v-for="item of"></div>'],
    ['<template>', '\r\n', '<div v-for="item of"></div>']
  ])('remaps template parser errors past synthetic and original prefixes: %s %j %s', (opening, newline, markup) => {
    const prefix = `<script>export default {}</script>${newline}${opening}${newline}`
    const source = `${prefix}${markup}</template>`
    const errorOffset = source.indexOf('of"') + 2
    const beforeError = source.slice(0, errorOffset)
    const expected = [{
      message: expect.any(String),
      line: beforeError.split('\n').length,
      column: errorOffset - beforeError.lastIndexOf('\n')
    }]
    expect(parseVueSource(source, 'Fixture.vue').document.errors).toEqual(expected)
    const analyzed = analyzeSourceText('Fixture.vue', source)
    expect(analyzed.preparedDocument.errors).toEqual(expected)
    expect(analyzed.fileResult.blocks.find(block => block.kind === 'script')?.status).toBe('available')
  })

  test('preserves independent same-message script errors at their own offsets', () => {
    const source = '<script>const first = ;</script>\r\n<script setup>const second = ;</script>'
    expect(parseVueSource(source, 'Fixture.vue').document.errors).toEqual([
      { message: expect.any(String), line: 1, column: source.indexOf(';') + 1 },
      { message: expect.any(String), line: 2, column: '<script setup>const second = '.length + 1 }
    ])
  })

  test('keeps block-start locations for unsupported syntax languages without parser positions', () => {
    const source = '<template><div /></template>\r\n<script lang="coffee">value = 1</script>'
    expect(parseVueSource(source, 'Fixture.vue').document.errors).toEqual([
      { message: 'Unsupported Vue script language: coffee', line: 2, column: '<script lang="coffee">'.length + 1 }
    ])
  })

  test('exposes the existing parsed SFC to downstream rules once', async () => {
    const root = await projectWithFile('<script setup>const label = "ok"</script><template><FixtureButton /></template>\n')
    const observed: Array<{ file: string; source: string; blockCount: number }> = []

    await scanVueSourceUsage({
      root,
      onVueFile({ file, source, parsed }) {
        observed.push({ file, source, blockCount: parsed.blocks.length })
      }
    })

    expect(observed).toEqual([{
      file: join(root, 'src/App.vue'),
      source: '<script setup>const label = "ok"</script><template><FixtureButton /></template>\n',
      blockCount: 3
    }])
  })

})
