import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DoctorRuleCheck,
  DoctorRulePack,
  DoctorRulePackContext,
  DoctorRulePackResult
} from '@vue-doctor/core'
import { createSourceDocument, type SourceDocument } from '@vue-doctor/source'

vi.mock('oxc-parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('oxc-parser')>()
  return { ...original, parseSync: vi.fn(original.parseSync) }
})

import { parseSync as parseOxc } from 'oxc-parser'
import {
  babelRule,
  defineRule,
  defineRuleEngine,
  defineRules,
  engineRule,
  oxcRule,
  scriptRule,
  type RuleSourceLocation
} from './index.js'

const root = '/workspace'

function context(documents?: readonly SourceDocument[], rules: DoctorRulePackContext['rules'] = {}): DoctorRulePackContext {
  return {
    inventory: { root, packages: {} },
    source: {
      root,
      files: documents?.map((document) => document.file) ?? [],
      components: [],
      globalPlugins: [],
      fileResults: []
    },
    components: [],
    rules,
    ...(documents === undefined ? {} : { documents })
  }
}

function document(file: string, source: string): SourceDocument {
  return createSourceDocument(`${root}/${file}`, source)
}

function manualDocument(
  file: string,
  source: string,
  block: Partial<SourceDocument['blocks'][number]>
): SourceDocument {
  return {
    file: `${root}/${file}`,
    text: source,
    language: file.split('.').pop() ?? '',
    errors: [],
    blocks: [{
      kind: 'script',
      lang: 'js',
      content: source,
      start: 0,
      end: source.length,
      loc: { line: 1, column: 1 },
      attributes: {},
      ...block
    }]
  }
}

function singleRule(
  name: string,
  check: ReturnType<typeof oxcRule> | ReturnType<typeof babelRule>,
  meta: Partial<ReturnType<typeof defineRule>['meta']> = {}
): DoctorRulePack {
  return defineRules({
    name,
    rules: {
      sample: defineRule({
        meta: { title: 'Sample', description: 'Sample custom rule.', ...meta },
        check
      })
    }
  })
}

async function run(
  pack: DoctorRulePack,
  documents?: readonly SourceDocument[],
  rules: DoctorRulePackContext['rules'] = {}
): Promise<DoctorRulePackResult> {
  return pack.run(context(documents, rules))
}

function check(result: DoctorRulePackResult, code: string): DoctorRuleCheck {
  const found = result.checks?.find((item) => item.ruleCode === code)
  if (!found) throw new Error(`Missing check ${code}`)
  return found
}

describe('@vue-doctor/rules', () => {
  beforeEach(() => {
    vi.mocked(parseOxc).mockClear()
  })

  it('namespaces local keys and validates the resulting DoctorRulePack', () => {
    const pack = singleRule('acme', oxcRule({ create: () => ({}) }))
    expect(pack.name).toBe('acme')
    expect(pack.rules[0]?.code).toBe('acme/sample')
    expect(pack.sourceExtensions).toContain('.vue')
    expect(() => defineRules({
      name: 'Bad Name',
      rules: { sample: defineRule({ meta: { title: 'A', description: 'B' }, check: oxcRule({ create: () => ({}) }) }) }
    })).toThrow('Each Doctor rule pack')
    expect(() => defineRules({
      name: 'acme',
      rules: { 'bad/key': defineRule({ meta: { title: 'A', description: 'B' }, check: oxcRule({ create: () => ({}) }) }) }
    })).toThrow('Custom Doctor rule keys')
    expect(() => defineRules({
      name: 'acme',
      rules: {
        sample: {
          meta: { title: 'A', description: 'B' },
          check: { kind: 'script', parser: 'other', create: () => ({}) }
        } as never
      }
    })).toThrow('must use an oxcRule, babelRule, or scriptRule check')
  })

  it('provides typed Oxc enter and exit visitors', async () => {
    const visits: string[] = []
    const pack = singleRule('visit', scriptRule({
      parser: 'oxc',
      create: () => ({
        VariableDeclaration(node) {
          visits.push(`enter:${node.kind}`)
        },
        'VariableDeclaration:exit'(node) {
          visits.push(`exit:${node.kind}`)
        }
      })
    }))
    const result = await run(pack, [document('entry.js', 'const value = 1')])
    expect(visits).toEqual(['enter:const', 'exit:const'])
    expect(check(result, 'visit/sample')).toMatchObject({ status: 'checked', files: 1 })
  })

  it.each([
    ['entry.js', 'const answer = 42', 'VariableDeclaration'],
    ['entry.ts', 'interface Props { value: number }', 'TSInterfaceDeclaration'],
    ['entry.tsx', 'const view = <main />', 'JSXElement'],
    ['entry.mjs', 'export const value = 1', 'ExportNamedDeclaration'],
    ['entry.cts', 'export = function value() {}', 'TSExportAssignment']
  ])('parses %s as %s syntax', async (file, source, nodeType) => {
    let found = false
    const pack = singleRule('languages', oxcRule({
      create: () => ({
        [nodeType]() {
          found = true
        }
      })
    }))
    const result = await run(pack, [document(file, source)])
    expect(found).toBe(true)
    expect(check(result, 'languages/sample').status).toBe('checked')
  })

  it('checks both classic and setup Vue script blocks with language aliases', async () => {
    const source = [
      '<script>const classic = 1</script>',
      '<script setup lang="typescript">const setup: number = 2</script>'
    ].join('\n')
    const names: string[] = []
    const pack = singleRule('vue-blocks', oxcRule({
      create: () => ({
        VariableDeclarator(node) {
          if (node.id.type === 'Identifier') names.push(node.id.name)
        }
      })
    }))
    const result = await run(pack, [document('Example.vue', source)])
    expect(names).toEqual(['classic', 'setup'])
    expect(check(result, 'vue-blocks/sample')).toMatchObject({ status: 'checked', files: 1 })
  })

  it('maps block-relative UTF-16 offsets through emoji and CRLF', async () => {
    const source = 'const emoji = "😀";\r\nlet target = 1;'
    let location: RuleSourceLocation | undefined
    const pack = singleRule('locations', oxcRule({
      create(ruleContext) {
        return {
          VariableDeclaration(node) {
            if (node.kind !== 'let') return
            location = ruleContext.location(node)
            ruleContext.report({
              node,
              message: 'Target declaration.',
              evidence: [{ kind: 'custom-script-ast', message: 'Custom evidence.' }],
              fixes: [{ title: 'Review the declaration.' }]
            })
          }
        }
      }
    }))
    const result = await run(pack, [document('emoji.js', source)])
    expect(location).toEqual({
      file: `${root}/emoji.js`,
      start: { offset: source.indexOf('let'), line: 2, column: 1 },
      end: { offset: source.length, line: 2, column: 16 }
    })
    expect(result.diagnostics[0]).toMatchObject({
      primaryLocation: { start: { line: 2, column: 1 }, end: { line: 2, column: 16 } },
      evidence: [{ kind: 'custom-script-ast', file: `${root}/emoji.js`, line: 2, column: 1, message: 'Custom evidence.' }],
      fixes: [{ title: 'Review the declaration.' }]
    })
  })

  it('exposes native Babel NodePath scope and keeps shadowed bindings distinct', async () => {
    const bindingStarts: number[] = []
    const pack = singleRule('babel-scope', babelRule({
      requires: { scope: true },
      create: () => ({
        ReferencedIdentifier(path) {
          if (path.node.name !== 'value') return
          const binding = path.scope.getBinding('value')
          if (binding?.identifier.start !== null && binding?.identifier.start !== undefined) {
            bindingStarts.push(binding.identifier.start)
          }
        }
      })
    }))
    const result = await run(pack, [document(
      'scope.js',
      'const value = 1; function read() { const value = 2; return value } value'
    )])
    expect(new Set(bindingStarts).size).toBe(2)
    expect(check(result, 'babel-scope/sample').status).toBe('checked')
  })

  it('accepts explicit Babel syntax plugins without implicit backend fallback', async () => {
    let decorators = 0
    const withPlugin = singleRule('babel-plugins', babelRule({
      parserOptions: { plugins: ['decorators'] },
      create: () => ({ Decorator() { decorators += 1 } })
    }))
    const source = '@sealed class Example {}'
    const checked = await run(withPlugin, [document('decorator.js', source)])
    expect(decorators).toBe(1)
    expect(check(checked, 'babel-plugins/sample').status).toBe('checked')

    const withoutPlugin = singleRule('babel-no-plugin', babelRule({ create: () => ({}) }))
    const failed = await run(withoutPlugin, [document('decorator.js', source)])
    expect(check(failed, 'babel-no-plugin/sample').status).toBe('unavailable')
    expect(failed.skippedChecks[0]?.reason).toBe('parse-failed')
  })

  it('rejects Babel options that violate native NodePath and block-relative offsets', async () => {
    const estree = singleRule('babel-estree', babelRule({
      parserOptions: { plugins: ['estree'] } as never,
      create: () => ({})
    }))
    const shifted = singleRule('babel-shifted', babelRule({
      parserOptions: { startLine: 10 } as never,
      create: () => ({})
    }))
    const source = [document('entry.js', 'const value = 1')]
    const [estreeResult, shiftedResult] = await Promise.all([run(estree, source), run(shifted, source)])
    expect(check(estreeResult, 'babel-estree/sample')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('estree')
    })
    expect(check(shiftedResult, 'babel-shifted/sample')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('block-relative')
    })
  })

  it('reports unavailable declared capabilities instead of pretending to check', async () => {
    const oxcPack = singleRule('oxc-scope', oxcRule({ requires: { scope: true }, create: () => ({}) }))
    const babelPack = singleRule('babel-types', babelRule({ requires: { types: true }, create: () => ({}) }))
    const source = [document('entry.ts', 'const value: number = 1')]
    const [oxc, babel] = await Promise.all([run(oxcPack, source), run(babelPack, source)])
    expect(check(oxc, 'oxc-scope/sample')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('scope') })
    expect(check(babel, 'babel-types/sample')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('types') })
    expect(oxc.skippedChecks[0]).toMatchObject({ required: true, reason: 'missing-capability' })
    expect(babel.skippedChecks[0]).toMatchObject({ required: true, reason: 'missing-capability' })
  })

  it('does not silently claim unsupported core metadata requirements', async () => {
    const ownership = singleRule(
      'ownership-meta',
      oxcRule({ create: () => ({}) }),
      { requires: { ownership: 'matched' } }
    )
    const vueVersion = singleRule(
      'vue-version-meta',
      oxcRule({ create: () => ({}) }),
      { requires: { vueVersion: 'known' } }
    )
    const source = [document('entry.js', 'const value = 1')]
    const [ownershipResult, versionResult] = await Promise.all([
      run(ownership, source),
      run(vueVersion, source)
    ])
    expect(check(ownershipResult, 'ownership-meta/sample')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('ownership')
    })
    expect(check(versionResult, 'vue-version-meta/sample')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('Vue version')
    })
  })

  it.each(['oxc', 'babel'] as const)('turns malformed %s syntax into a required parse skip', async (parser) => {
    const rule = parser === 'oxc'
      ? oxcRule({ create: () => ({}) })
      : babelRule({ create: () => ({}) })
    const pack = singleRule(`${parser}-malformed`, rule)
    const result = await run(pack, [document('broken.js', 'const =')])
    expect(check(result, `${parser}-malformed/sample`).status).toBe('unavailable')
    expect(result.skippedChecks[0]).toMatchObject({ required: true, reason: 'parse-failed', file: `${root}/broken.js` })
  })

  it('reports external, unsupported, and structurally invalid script blocks', async () => {
    const pack = singleRule('prerequisites', oxcRule({ create: () => ({}) }))
    const result = await run(pack, [
      manualDocument('external.vue', '', { attributes: { src: './external.ts' } }),
      manualDocument('coffee.vue', 'value = 1', { lang: 'coffee' }),
      manualDocument('invalid.vue', 'const value = 1', { start: 1, end: 16 })
    ])
    expect(check(result, 'prerequisites/sample')).toMatchObject({ status: 'unavailable', files: 0 })
    expect(result.skippedChecks).toHaveLength(3)
    expect(result.skippedChecks.every((item) => item.required && item.reason === 'missing-capability')).toBe(true)
  })

  it('does not treat unrelated document parser errors as backend failures', async () => {
    const source = 'const value = do { 1 }'
    const input = document('proposal.js', source)
    input.errors.push({ message: 'Template parser failed elsewhere.', line: 1, column: 1 })
    const pack = singleRule('document-errors', babelRule({
      parserOptions: { plugins: ['doExpressions'] },
      create: () => ({})
    }))
    const result = await run(pack, [input])
    expect(check(result, 'document-errors/sample').status).toBe('checked')
    expect(result.skippedChecks).toEqual([])
  })

  it('uses authoritative SFC structural failures for script and global errors', async () => {
    const pack = singleRule('sfc-structure', oxcRule({ create: () => ({}) }))
    const scriptFailure = document('ScriptFailure.vue', '<script>const value = 1</script>')
    scriptFailure.structuralFailures = [{
      block: 'script', message: 'Malformed script close tag.', line: 1, column: 24
    }]
    const globalFailure = document('GlobalFailure.vue', '<script setup>const value = 1</script>')
    globalFailure.structuralFailures = [{ message: 'Malformed SFC structure.', line: 1, column: 1 }]
    const result = await run(pack, [scriptFailure, globalFailure])
    expect(check(result, 'sfc-structure/sample')).toMatchObject({ status: 'unavailable', files: 0 })
    expect(result.skippedChecks).toHaveLength(2)
    expect(result.skippedChecks.map((item) => item.reason)).toEqual(['parse-failed', 'parse-failed'])
    expect(result.skippedChecks[0]?.evidence[0]).toMatchObject({ line: 1, column: 24 })
  })

  it('does not let a template-only structural failure block a readable script', async () => {
    const input = document('TemplateFailure.vue', '<script>const value = 1</script>')
    input.structuralFailures = [{
      block: 'template', message: 'Malformed template structure.', line: 1, column: 1
    }]
    const pack = singleRule('template-structure', oxcRule({ create: () => ({}) }))
    const result = await run(pack, [input])
    expect(check(result, 'template-structure/sample').status).toBe('checked')
    expect(result.skippedChecks).toEqual([])
  })

  it('checks a required template only with authoritative available parser evidence', async () => {
    let invoked = false
    const pack = singleRule(
      'template-companion-valid',
      oxcRule({ create: () => { invoked = true; return {} } }),
      { requires: { sourceBlocks: ['script'], allSourceBlocks: ['template'] } }
    )
    const input = document(
      'Companion.vue',
      '<template><main /></template>\n<script>const value = 1</script>'
    )
    const packContext = context([input])
    packContext.source.fileResults = [{
      file: input.file,
      blocks: [{ kind: 'template', status: 'available' }]
    }]
    const result = await pack.run(packContext)
    expect(invoked).toBe(true)
    expect(check(result, 'template-companion-valid/sample').status).toBe('checked')
    expect(result.skippedChecks).toEqual([])
  })

  it('blocks a required template when authoritative parsing failed', async () => {
    let invoked = false
    const pack = singleRule(
      'template-companion-malformed',
      oxcRule({ create: () => { invoked = true; return {} } }),
      { requires: { sourceBlocks: ['script'], allSourceBlocks: ['template'] } }
    )
    const input = document(
      'MalformedTemplate.vue',
      '<template><main /></template>\n<script>const value = 1</script>'
    )
    const packContext = context([input])
    packContext.source.fileResults = [{
      file: input.file,
      blocks: [{ kind: 'template', status: 'failed', message: 'Template parser rejected the block.' }]
    }]
    const result = await pack.run(packContext)
    expect(invoked).toBe(false)
    expect(check(result, 'template-companion-malformed/sample')).toMatchObject({
      status: 'unavailable', reason: 'Template parser rejected the block.'
    })
    expect(result.skippedChecks[0]).toMatchObject({ required: true, reason: 'parse-failed' })
  })

  it('does not infer required template readability when parser evidence is missing', async () => {
    let invoked = false
    const pack = singleRule(
      'template-companion-missing',
      oxcRule({ create: () => { invoked = true; return {} } }),
      { requires: { sourceBlocks: ['script'], allSourceBlocks: ['template'] } }
    )
    const input = document(
      'MissingTemplateEvidence.vue',
      '<template><main /></template>\n<script>const value = 1</script>'
    )
    const result = await run(pack, [input])
    expect(invoked).toBe(false)
    expect(check(result, 'template-companion-missing/sample')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('parser capability evidence')
    })
    expect(result.skippedChecks[0]).toMatchObject({ required: true, reason: 'missing-capability' })
  })

  it('parses required script companions with the chosen backend before running primary callbacks', async () => {
    let invoked = false
    const pack = singleRule(
      'script-companion-malformed',
      oxcRule({
        create(ruleContext) {
          invoked = true
          return {
            VariableDeclaration(node) {
              ruleContext.report({ node, message: 'Must remain clean when the companion fails.' })
            }
          }
        }
      }),
      { requires: { sourceBlocks: ['script'], allSourceBlocks: ['script-setup'] } }
    )
    const input = document(
      'MalformedSetup.vue',
      '<script>const primary = 1</script>\n<script setup>const =</script>'
    )
    const result = await run(pack, [input])
    expect(invoked).toBe(false)
    expect(parseOxc).toHaveBeenCalledTimes(1)
    expect(vi.mocked(parseOxc).mock.calls[0]?.[1]).toBe('const =')
    expect(result.diagnostics).toEqual([])
    expect(check(result, 'script-companion-malformed/sample').status).toBe('unavailable')
    expect(result.skippedChecks[0]).toMatchObject({ required: true, reason: 'parse-failed' })
  })

  it('rolls back a failed callback block without affecting other rules', async () => {
    const pack = defineRules({
      name: 'callback-isolation',
      rules: {
        failing: defineRule({
          meta: { title: 'Failing', description: 'Fails after reporting.' },
          check: oxcRule({
            create(ruleContext) {
              return {
                VariableDeclaration(node) {
                  ruleContext.report({ node, message: 'Must be rolled back.' })
                  throw new Error('intentional callback failure')
                }
              }
            }
          })
        }),
        healthy: defineRule({
          meta: { title: 'Healthy', description: 'Still runs.' },
          check: oxcRule({
            create(ruleContext) {
              return { VariableDeclaration(node) { ruleContext.report({ node, message: 'Kept.' }) } }
            }
          })
        })
      }
    })
    const result = await run(pack, [document('entry.js', 'const value = 1')])
    expect(result.diagnostics.map((item) => item.code)).toEqual(['callback-isolation/healthy'])
    expect(check(result, 'callback-isolation/failing').status).toBe('unavailable')
    expect(check(result, 'callback-isolation/healthy').status).toBe('checked')
  })

  it('honors defaultEnabled and explicit rule settings', async () => {
    const pack = singleRule(
      'selection',
      oxcRule({ create: () => ({}) }),
      { defaultEnabled: false }
    )
    const source = [document('entry.js', 'const value = 1')]
    expect(check(await run(pack, source), 'selection/sample').status).toBe('disabled')
    expect(check(await run(pack, source, { 'selection/sample': 'warning' }), 'selection/sample').status).toBe('checked')
    expect(check(await run(pack, source, { 'selection/sample': 'off' }), 'selection/sample').status).toBe('disabled')
  })

  it.each(['manual', 'runtime', 'policy-pending'] as const)(
    'preserves %s verification without executing a static callback',
    async (verification) => {
      let invoked = false
      const pack = singleRule(
        `verification-${verification}`,
        oxcRule({ create: () => { invoked = true; return {} } }),
        { verification }
      )
      const result = await run(pack, [document('entry.js', 'const value = 1')])
      expect(invoked).toBe(false)
      expect(check(result, `verification-${verification}/sample`)).toMatchObject({
        status: verification,
        reason: 'Sample custom rule.'
      })
    }
  )

  it('uses Doctor applicability before invoking a rule', async () => {
    let invoked = false
    const pack = singleRule(
      'applicability',
      oxcRule({ create: () => { invoked = true; return {} } }),
      { applicability: { vue: { only: 2 } } }
    )
    const packContext = context([document('entry.js', 'const value = 1')])
    packContext.inventory.vue = {
      dependencyName: 'vue', canonicalName: 'vue', declaredVersion: '3.5.0', importRoots: [], source: 'declared'
    }
    const result = await pack.run(packContext)
    expect(invoked).toBe(false)
    expect(check(result, 'applicability/sample').status).toBe('not-applicable')
  })

  it('resolves Vue applicability per owned document without falling back from an unknown owner', async () => {
    const visited: string[] = []
    const pack = singleRule(
      'workspace-applicability',
      oxcRule({ create: (ruleContext) => {
        visited.push(ruleContext.document.file)
        return {}
      } }),
      { applicability: { vue: { only: 3 } } }
    )
    const rootFile = document('root.js', 'const rootValue = 1')
    const childFile = document('packages/child/entry.js', 'const childValue = 1')
    const mixed = context([rootFile, childFile])
    mixed.inventory.vue = {
      dependencyName: 'vue', canonicalName: 'vue', declaredVersion: '2.7.16', importRoots: [], source: 'declared'
    }
    mixed.projectContext = {
      root,
      files: [rootFile.file, childFile.file],
      applications: [],
      issues: [],
      packages: [{
        root: `${root}/packages/child`,
        targetFiles: [childFile.file],
        inventory: {
          root: `${root}/packages/child`,
          packages: {},
          vue: {
            dependencyName: 'vue', canonicalName: 'vue', declaredVersion: '3.5.0', importRoots: [], source: 'declared'
          }
        }
      }]
    }
    const mixedResult = await pack.run(mixed)
    expect(visited).toEqual([childFile.file])
    expect(check(mixedResult, 'workspace-applicability/sample')).toMatchObject({ status: 'checked', files: 1 })

    visited.length = 0
    mixed.inventory.vue.declaredVersion = '3.5.0'
    mixed.projectContext.packages[0]!.inventory.vue = undefined
    const unknownOwner = await pack.run(mixed)
    expect(visited).toEqual([rootFile.file])
    expect(check(unknownOwner, 'workspace-applicability/sample')).toMatchObject({ status: 'partial', files: 1 })
    expect(unknownOwner.skippedChecks[0]).toMatchObject({ file: childFile.file, reason: 'missing-capability' })
  })

  it('distinguishes partial from wholly unavailable multi-file coverage', async () => {
    const pack = singleRule('coverage', oxcRule({ create: () => ({}) }))
    const good = document('good.js', 'const value = 1')
    const bad = document('bad.js', 'const =')
    const partial = await run(pack, [good, bad])
    const unavailable = await run(pack, [bad])
    expect(check(partial, 'coverage/sample')).toMatchObject({ status: 'partial', files: 1 })
    expect(check(unavailable, 'coverage/sample')).toMatchObject({ status: 'unavailable', files: 0 })
  })

  it('distinguishes missing documents from zero files and no script blocks', async () => {
    const pack = singleRule('empty-input', oxcRule({ create: () => ({}) }))
    const missing = await run(pack)
    const empty = await run(pack, [])
    const templateOnly = await run(pack, [document('OnlyTemplate.vue', '<template><main /></template>')])
    expect(check(missing, 'empty-input/sample').status).toBe('unavailable')
    expect(missing.skippedChecks[0]).toMatchObject({ required: true, reason: 'missing-capability' })
    expect(check(empty, 'empty-input/sample')).toMatchObject({ status: 'not-applicable', files: 0 })
    expect(check(templateOnly, 'empty-input/sample')).toMatchObject({ status: 'not-applicable', files: 0 })
  })

  it('parses identical Oxc inputs once per run and isolates mutable AST clones', async () => {
    let secondKind: string | undefined
    const pack = defineRules({
      name: 'cache',
      rules: {
        mutate: defineRule({
          meta: { title: 'Mutate', description: 'Mutates its private clone.' },
          check: oxcRule({
            create: () => ({ VariableDeclaration(node) { node.kind = 'var' } })
          })
        }),
        observe: defineRule({
          meta: { title: 'Observe', description: 'Observes the pristine clone.' },
          check: oxcRule({
            create: () => ({ VariableDeclaration(node) { secondKind = node.kind } })
          })
        })
      }
    })
    const result = await run(pack, [document('entry.js', 'const value = 1')])
    expect(parseOxc).toHaveBeenCalledTimes(1)
    expect(secondKind).toBe('const')
    expect(result.checks?.map((item) => item.status)).toEqual(['checked', 'checked'])
  })

  it('isolates Babel AST mutation between rules sharing a cached parse', async () => {
    const observed: string[] = []
    const pack = defineRules({
      name: 'babel-isolation',
      rules: {
        mutate: defineRule({
          meta: { title: 'Mutate', description: 'Mutates its private Babel clone.' },
          check: babelRule({
            create: () => ({ Identifier(path) { if (path.node.name === 'value') path.node.name = 'changed' } })
          })
        }),
        observe: defineRule({
          meta: { title: 'Observe', description: 'Observes an independent Babel clone.' },
          check: babelRule({
            create: () => ({ Identifier(path) { observed.push(path.node.name) } })
          })
        })
      }
    })
    await run(pack, [document('entry.js', 'const value = 1; value')])
    expect(observed).toEqual(['value', 'value'])
  })

  it('batches enabled rules once by engine identity and merges engine source extensions', async () => {
    const firstCalls: Array<readonly { code: string; config: { threshold: number } }[]> = []
    const secondCalls: string[][] = []
    const first = defineRuleEngine<{ threshold: number }>({
      name: 'first-engine',
      sourceExtensions: ['.astro', '.vue'],
      runBatch(_context, entries) {
        firstCalls.push(entries.map(({ definition, config }) => ({ code: definition.code, config })))
        return {
          diagnostics: [], skippedChecks: [],
          checks: entries.map(({ definition }) => ({ ruleCode: definition.code, status: 'checked' }))
        }
      }
    })
    const second = defineRuleEngine<string>({
      name: 'second-engine',
      sourceExtensions: ['.svelte'],
      runBatch(_context, entries) {
        secondCalls.push(entries.map(({ definition }) => definition.code))
        return {
          diagnostics: [], skippedChecks: [],
          checks: entries.map(({ definition }) => ({ ruleCode: definition.code, status: 'not-applicable', files: 0 }))
        }
      }
    })
    if (false) {
      // @ts-expect-error The engine config remains inferred at the rule call site.
      engineRule(first, { threshold: 'wrong' })
    }
    const pack = defineRules({
      name: 'batching',
      rules: {
        first: defineRule({ meta: { title: 'First', description: 'First.' }, check: engineRule(first, { threshold: 1 }) }),
        second: defineRule({ meta: { title: 'Second', description: 'Second.' }, check: engineRule(second, 'value') }),
        third: defineRule({ meta: { title: 'Third', description: 'Third.' }, check: engineRule(first, { threshold: 3 }) })
      }
    })
    const result = await run(pack, [document('entry.js', 'const value = 1')])

    expect(firstCalls).toEqual([[{
      code: 'batching/first', config: { threshold: 1 }
    }, {
      code: 'batching/third', config: { threshold: 3 }
    }]])
    expect(secondCalls).toEqual([['batching/second']])
    expect(result.checks?.map(({ ruleCode, status }) => [ruleCode, status])).toEqual([
      ['batching/first', 'checked'],
      ['batching/second', 'not-applicable'],
      ['batching/third', 'checked']
    ])
    expect(pack.sourceExtensions).toEqual(expect.arrayContaining(['.js', '.vue', '.astro', '.svelte']))
    expect(pack.sourceExtensions?.filter((extension) => extension === '.vue')).toHaveLength(1)
  })

  it('keeps selection and non-static verification outside the engine while forwarding missing and empty documents', async () => {
    const received: Array<{ codes: string[]; documents: DoctorRulePackContext['documents'] }> = []
    const engine = defineRuleEngine<number>({
      name: 'selection-engine',
      runBatch(packContext, entries) {
        received.push({ codes: entries.map(({ definition }) => definition.code), documents: packContext.documents })
        return {
          diagnostics: [], skippedChecks: [],
          checks: entries.map(({ definition }) => ({ ruleCode: definition.code, status: 'checked' }))
        }
      }
    })
    const pack = defineRules({
      name: 'engine-selection',
      rules: {
        active: defineRule({ meta: { title: 'Active', description: 'Active.' }, check: engineRule(engine, 1) }),
        optin: defineRule({ meta: { title: 'Opt in', description: 'Opt in.', defaultEnabled: false }, check: engineRule(engine, 2) }),
        disabled: defineRule({ meta: { title: 'Disabled', description: 'Disabled.' }, check: engineRule(engine, 3) }),
        manual: defineRule({ meta: { title: 'Manual', description: 'Manual.', verification: 'manual' }, check: engineRule(engine, 4) }),
        runtime: defineRule({ meta: { title: 'Runtime', description: 'Runtime.', verification: 'runtime' }, check: engineRule(engine, 5) }),
        'policy-pending': defineRule({
          meta: { title: 'Policy', description: 'Policy.', verification: 'policy-pending' },
          check: engineRule(engine, 6)
        })
      }
    })
    const settings = { 'engine-selection/optin': 'warning', 'engine-selection/disabled': 'off' } as const
    const missing = await run(pack, undefined, settings)
    const empty = await run(pack, [], settings)

    expect(received.map(({ codes }) => codes)).toEqual([
      ['engine-selection/active', 'engine-selection/optin'],
      ['engine-selection/active', 'engine-selection/optin']
    ])
    expect(received[0]?.documents).toBeUndefined()
    expect(received[1]?.documents).toEqual([])
    expect(check(missing, 'engine-selection/disabled').status).toBe('disabled')
    expect(check(missing, 'engine-selection/manual')).toMatchObject({ status: 'manual', reason: 'Manual.' })
    expect(check(missing, 'engine-selection/runtime')).toMatchObject({ status: 'runtime', reason: 'Runtime.' })
    expect(check(missing, 'engine-selection/policy-pending')).toMatchObject({
      status: 'policy-pending', reason: 'Policy.'
    })
    expect(check(empty, 'engine-selection/active').status).toBe('checked')
  })

  it('turns a missing engine execution record into a required unavailable skip without keeping its diagnostics', async () => {
    const engine = defineRuleEngine<undefined>({
      name: 'missing-check-engine',
      runBatch(_context, entries) {
        return {
          diagnostics: [{
            code: entries[1]!.definition.code,
            severity: 'warning', message: 'Must be discarded.', evidence: [], fixes: [], confidence: 'high'
          }],
          skippedChecks: [],
          checks: [{ ruleCode: entries[0]!.definition.code, status: 'checked' }]
        }
      }
    })
    const pack = defineRules({
      name: 'missing-check',
      rules: {
        kept: defineRule({ meta: { title: 'Kept', description: 'Kept.' }, check: engineRule(engine, undefined) }),
        missing: defineRule({ meta: { title: 'Missing', description: 'Missing.' }, check: engineRule(engine, undefined) })
      }
    })
    const result = await run(pack, [document('entry.js', 'const value = 1')])

    expect(result.diagnostics).toEqual([])
    expect(check(result, 'missing-check/kept').status).toBe('checked')
    expect(check(result, 'missing-check/missing')).toMatchObject({
      status: 'unavailable', reason: expect.stringContaining('did not return an execution record')
    })
    expect(result.skippedChecks).toEqual([expect.objectContaining({
      ruleCode: 'missing-check/missing', required: true, reason: 'missing-capability'
    })])
  })

  it('accepts engine-owned policy and applicability decisions for otherwise enabled rules', async () => {
    const engine = defineRuleEngine<'disabled' | 'policy-pending'>({
      name: 'policy-engine',
      runBatch(_context, entries) {
        return {
          diagnostics: [], skippedChecks: [],
          checks: entries.map(({ definition, config }) => ({
            ruleCode: definition.code,
            status: config,
            reason: 'Engine policy decision.'
          }))
        }
      }
    })
    const pack = defineRules({
      name: 'engine-policy',
      rules: {
        disabled: defineRule({
          meta: { title: 'Disabled policy', description: 'Disabled policy.' },
          check: engineRule(engine, 'disabled')
        }),
        pending: defineRule({
          meta: { title: 'Pending policy', description: 'Pending policy.' },
          check: engineRule(engine, 'policy-pending')
        })
      }
    })
    const result = await run(pack, [])
    expect(check(result, 'engine-policy/disabled').status).toBe('disabled')
    expect(check(result, 'engine-policy/pending').status).toBe('policy-pending')
    expect(result.skippedChecks).toEqual([])
  })

  it.each(['unknown-code', 'duplicate-check', 'exception'] as const)(
    'rolls back the whole engine batch on %s contract failure',
    async (failure) => {
      const engine = defineRuleEngine<undefined>({
        name: `broken-${failure}`,
        runBatch(_context, entries) {
          if (failure === 'exception') throw new Error('intentional engine failure')
          const code = entries[0]!.definition.code
          return {
            diagnostics: [{
              code, severity: 'warning', message: 'Must be rolled back.', evidence: [], fixes: [], confidence: 'high'
            }],
            skippedChecks: [],
            checks: failure === 'unknown-code'
              ? [{ ruleCode: 'other/not-active', status: 'checked' }]
              : [{ ruleCode: code, status: 'checked' }, { ruleCode: code, status: 'checked' }]
          }
        }
      })
      const pack = defineRules({
        name: `engine-${failure}`,
        rules: {
          sample: defineRule({ meta: { title: 'Sample', description: 'Sample.' }, check: engineRule(engine, undefined) })
        }
      })
      const result = await run(pack, [document('entry.js', 'const value = 1')])

      expect(result.diagnostics).toEqual([])
      expect(check(result, `engine-${failure}/sample`).status).toBe('unavailable')
      expect(result.skippedChecks).toEqual([expect.objectContaining({ required: true, reason: 'missing-capability' })])
    }
  )

  it('keeps native parsing cached within each run while engine batches have no cross-run state', async () => {
    const entryArrays: unknown[][] = []
    const engine = defineRuleEngine<boolean>({
      name: 'mixed-engine',
      runBatch(_context, entries) {
        entryArrays.push([...entries])
        return {
          diagnostics: [], skippedChecks: [],
          checks: entries.map(({ definition }) => ({ ruleCode: definition.code, status: 'checked' }))
        }
      }
    })
    const pack = defineRules({
      name: 'mixed-engine-native',
      rules: {
        'native-first': defineRule({ meta: { title: 'Native one', description: 'Native one.' }, check: oxcRule({ create: () => ({}) }) }),
        engine: defineRule({ meta: { title: 'Engine', description: 'Engine.' }, check: engineRule(engine, true) }),
        'native-second': defineRule({ meta: { title: 'Native two', description: 'Native two.' }, check: oxcRule({ create: () => ({}) }) })
      }
    })
    const source = [document('entry.js', 'const value = 1')]
    const first = await run(pack, source)
    const second = await run(pack, source)

    expect(parseOxc).toHaveBeenCalledTimes(2)
    expect(entryArrays).toHaveLength(2)
    expect(entryArrays[0]).not.toBe(entryArrays[1])
    expect(first.checks?.map(({ ruleCode }) => ruleCode)).toEqual([
      'mixed-engine-native/native-first', 'mixed-engine-native/engine', 'mixed-engine-native/native-second'
    ])
    expect(second.checks?.every(({ status }) => status === 'checked')).toBe(true)
  })

  it('validates engine definitions and forged registrations', () => {
    expect(() => defineRuleEngine({ name: '', runBatch: () => ({ diagnostics: [], skippedChecks: [] }) })).toThrow(
      'non-empty name'
    )
    expect(() => defineRules({
      name: 'forged-engine',
      rules: {
        sample: defineRule({
          meta: { title: 'Sample', description: 'Sample.' },
          check: { kind: 'engine', engine: { name: 'broken' }, config: undefined } as never
        })
      }
    })).toThrow('or an engineRule check')
  })
})
