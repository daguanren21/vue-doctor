import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Linter, type Rule } from 'eslint'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import type { DoctorRulePackContext } from '@vue-doctor/core'
import { createSourceDocument } from '@vue-doctor/source'
import { defineRule, defineRules, engineRule } from '@vue-doctor/rules'
import { createEslintRuleEngine, eslintRule, type EslintRuleConfig } from './index.js'

vi.mock('@typescript-eslint/parser', async importOriginal => {
  const actual = await importOriginal<typeof import('@typescript-eslint/parser')>()
  return { ...actual, [Symbol.for('eslint.RuleTester.parser')]: undefined, clearCaches: vi.fn(actual.clearCaches) }
})
import { clearCaches } from '@typescript-eslint/parser'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(clearCaches).mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(file: string, text: string, project = false): Promise<DoctorRulePackContext> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-eslint-'))
  roots.push(root)
  await writeFile(join(root, file), text)
  if (project) await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
  return {
    inventory: { root, packages: {} },
    source: { root, files: [join(root, file)], components: [], globalPlugins: [], fileResults: [] },
    components: [], rules: {}, documents: [createSourceDocument(join(root, file), text)]
  }
}

function meta() { return { title: 'Example', description: 'Example AST check.' } }
const reportModule: Rule.RuleModule = {
  meta: { schema: [] },
  create(context) { return { Program(node) { context.report({ node, message: 'Example finding.' }) } } }
}

test('independent official delegates share one parse and preserve SFC coordinates', async () => {
  const verify = vi.spyOn(Linter.prototype, 'verify')
  const pack = defineRules({ name: 'example', rules: {
    debugger: defineRule({ meta: meta(), check: eslintRule({ module: builtinRules.get('no-debugger')! }) }),
    equality: defineRule({ meta: meta(), check: eslintRule({ module: builtinRules.get('eqeqeq')! }) })
  } })
  const result = await pack.run(await fixture('Sample.vue', '<template><div>😀</div></template>\r\n<script setup lang="ts">\r\ndebugger;\r\nconst same = 1 == 2\r\n</script>'))
  expect(verify).toHaveBeenCalledTimes(1)
  expect(result.skippedChecks).toEqual([])
  expect(result.diagnostics.map(d => [d.code, d.evidence[0]?.line, d.evidence[0]?.column])).toEqual([
    ['example/debugger', 3, 1], ['example/equality', 4, 16]
  ])
  expect(result.checks?.map(c => c.status)).toEqual(['checked', 'checked'])
})

test('scope and comments belong to the native ESTree parser rather than spelling matches', async () => {
  const module: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      return {
        CallExpression(node) {
          if (node.callee.type !== 'Identifier' || node.callee.name !== 'String') return
          let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(node)
          while (scope && !scope.set.has('String')) scope = scope.upper
          if (scope?.set.get('String')?.defs.length) return
          expect(context.sourceCode.getAllComments()).toHaveLength(1)
          context.report({ node, message: 'Global conversion.' })
        }
      }
    }
  }
  const pack = defineRules({ name: 'example', rules: { scope: defineRule({ meta: meta(), check: eslintRule({ module }) }) } })
  const result = await pack.run(await fixture('sample.ts', '// comment\nfunction convert(String: (x: unknown) => string) { return String(1) }\nString(2)'))
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.evidence[0]?.line).toBe(3)
})

test('type rules receive a real consumer program and ESTree-to-TypeScript maps', async () => {
  const module: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      const services = context.sourceCode.parserServices as {
        program?: { getTypeChecker(): { typeToString(type: unknown): string; getTypeAtLocation(node: unknown): unknown } }
        esTreeNodeToTSNodeMap?: { get(node: unknown): unknown }
      }
      return { VariableDeclarator(node) {
        const checker = services.program!.getTypeChecker()
        const type = checker.typeToString(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap!.get(node.id)))
        context.report({ node: node.id, message: `Resolved ${type}.` })
      } }
    }
  }
  const pack = defineRules({ name: 'example', rules: { typed: defineRule({ meta: meta(), check: eslintRule({ module, typed: true }) }) } })
  const result = await pack.run(await fixture('sample.ts', 'const ready: boolean = true', true))
  expect(result.skippedChecks).toEqual([])
  expect(result.diagnostics[0]?.message).toBe('Resolved boolean.')
})

test('conditional deferred type stages require a program only when requested', async () => {
  let defer = false
  const config: EslintRuleConfig = {
    module: reportModule,
    onMessage: () => defer ? { defer: true } : null,
    deferred: { module: reportModule, typed: true }
  }
  const pack = defineRules({ name: 'example', rules: { contract: defineRule({ meta: meta(), check: eslintRule(config) }) } })
  const context = await fixture('sample.ts', 'const value = 1')
  expect((await pack.run(context)).checks?.[0]?.status).toBe('checked')
  defer = true
  const result = await pack.run(context)
  expect(result.checks?.[0]?.status).toBe('unavailable')
  expect(result.skippedChecks[0]).toMatchObject({ required: true, reason: 'missing-capability' })
  expect(result.skippedChecks[0]?.evidence[0]?.message).toContain('real type program')
})

test('per-run services are disposed and disabled rules never enter the batch', async () => {
  const prepare = vi.fn(() => ({ generation: Symbol() }))
  const dispose = vi.fn()
  const engine = createEslintRuleEngine({ prepare, dispose })
  const moduleFactory = vi.fn(() => reportModule)
  const pack = defineRules({ name: 'example', rules: {
    enabled: defineRule({ meta: meta(), check: engineRule(engine, { module: moduleFactory }) }),
    disabled: defineRule({ meta: { ...meta(), defaultEnabled: false }, check: engineRule(engine, { module: moduleFactory }) })
  } })
  const context = await fixture('sample.js', 'let value = 1')
  const first = await pack.run(context)
  await pack.run(context)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(dispose).toHaveBeenCalledTimes(2)
  expect(moduleFactory).toHaveBeenCalledTimes(2)
  expect(first.checks?.map(c => c.status)).toEqual(['checked', 'disabled'])
  expect(prepare.mock.results[0]?.value.generation).not.toBe(prepare.mock.results[1]?.value.generation)
})

test('parser and adapter failures produce required skips without partial findings', async () => {
  const pack = defineRules({ name: 'example', rules: {
    first: defineRule({ meta: meta(), check: eslintRule({ module: reportModule }) }),
    throws: defineRule({ meta: meta(), check: eslintRule({ module: reportModule, onMessage() { throw new Error('adapter failed') } }) })
  } })
  const failed = await pack.run(await fixture('sample.js', 'let value = 1'))
  expect(failed.diagnostics).toEqual([])
  expect(failed.checks?.every(c => c.status === 'unavailable')).toBe(true)
  const syntax = await pack.run(await fixture('broken.ts', 'const ='))
  expect(syntax.diagnostics).toEqual([])
  expect(syntax.skippedChecks.every(c => c.required && c.reason === 'parse-failed')).toBe(true)
})

test('missing documents and external SFC blocks cannot be counted as checked', async () => {
  const pack = defineRules({ name: 'example', rules: { sample: defineRule({ meta: meta(), check: eslintRule({ module: reportModule }) }) } })
  const context = await fixture('Sample.vue', '<script src="./external.ts"></script>')
  expect((await pack.run(context)).checks?.[0]?.status).toBe('unavailable')
  const { documents: _documents, ...without } = context
  expect((await pack.run(without)).skippedChecks[0]?.required).toBe(true)
  expect((await pack.run({ ...context, documents: [] })).checks?.[0]?.status).toBe('not-applicable')
})

test('an inactive document cannot erase earlier execution, regardless of document order', async () => {
  const engine = createEslintRuleEngine()
  const pack = defineRules({ name: 'example', rules: { sample: defineRule({ meta: meta(), check: engineRule(engine, {
    module: reportModule,
    select: dc => dc.document.file.endsWith('inactive.js') ? { status: 'not-applicable', reason: 'Only active files apply.' } : true
  }) }) } })
  const context = await fixture('active.js', 'let value = 1')
  const inactive = createSourceDocument(join(context.inventory.root, 'inactive.js'), 'let value = 2')
  for (const documents of [[...context.documents!, inactive], [inactive, ...context.documents!]]) {
    const result = await pack.run({ ...context, documents })
    expect(result.diagnostics).toHaveLength(1)
    expect(result.checks?.[0]).toMatchObject({ status: 'checked', files: 1 })
    expect(result.checks?.[0]?.reason).toBeUndefined()
  }
})

test('typed checks discover a nested consumer project when the scan root has no tsconfig', async () => {
  const context = await fixture('placeholder.js', '')
  const app = join(context.inventory.root, 'apps/example')
  await mkdir(app, { recursive: true })
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }))
  const file = join(app, 'sample.ts')
  await writeFile(file, 'const ready: boolean = true')
  const pack = defineRules({ name: 'example', rules: { typed: defineRule({ meta: meta(), check: eslintRule({ module: reportModule, typed: true }) }) } })
  const result = await pack.run({ ...context, documents: [createSourceDocument(file, 'const ready: boolean = true')] })
  expect(result.skippedChecks).toEqual([])
  expect(result.checks?.[0]?.status).toBe('checked')
})

test('ordinary checks do not clear another consumer project service; typed syntax failures remain parse-failed', async () => {
  const ordinary = defineRules({ name: 'example', rules: { ordinary: defineRule({ meta: meta(), check: eslintRule({ module: reportModule }) }) } })
  await ordinary.run(await fixture('sample.ts', 'const ready = true'))
  expect(clearCaches).not.toHaveBeenCalled()
  const typed = defineRules({ name: 'example', rules: { typed: defineRule({ meta: meta(), check: eslintRule({ module: reportModule, typed: true }) }) } })
  const result = await typed.run(await fixture('broken.ts', 'const =', true))
  expect(result.skippedChecks[0]).toMatchObject({ reason: 'parse-failed', required: true })
  expect(clearCaches).toHaveBeenCalledTimes(2)
})

test('fault reports and native context ids remain stable when preceding rules are disabled', async () => {
  const ids: string[] = []
  const faulty: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      ids.push(context.id)
      return { Program() { throw new Error('Visitor failed.') } }
    }
  }
  const pack = defineRules({ name: 'example', rules: {
    preceding: defineRule({ meta: meta(), check: eslintRule({ module: reportModule }) }),
    faulty: defineRule({ meta: meta(), check: eslintRule({ module: faulty }) })
  } })
  const firstContext = await fixture('sample.js', 'const value = 1')
  const secondContext = await fixture('sample.js', 'const value = 1')
  const first = await pack.run(firstContext)
  const second = await pack.run({ ...secondContext, rules: { 'example/preceding': 'off' } })
  const reason = (result: Awaited<ReturnType<typeof pack.run>>) => result.skippedChecks.find(skip => skip.ruleCode === 'example/faulty')!.evidence[0]!.message
  expect(reason(first)).toBe(reason(second))
  expect(reason(first)).toContain('example/faulty')
  expect(reason(first)).not.toContain(firstContext.inventory.root)
  expect(ids[0]).toBe(ids[1])
})
