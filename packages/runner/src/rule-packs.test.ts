import { describe, expect, test } from 'vitest'
import type { DoctorRulePack, DoctorRulePackContext } from '@vue-doctor/core'
import { runRulePacks, selectRulePackSourceExtensions } from './rule-packs.js'

const context: DoctorRulePackContext = {
  inventory: { root: '/fixture', packages: {} },
  source: { root: '/fixture', files: [], components: [], globalPlugins: [], fileResults: [] },
  components: [], rules: {}
}

test('isolates source and target snapshots between trusted rule packs', async () => {
  const input: DoctorRulePackContext = { ...context,
    targetFiles: { root: '/fixture', files: ['/fixture/App.vue'], issues: [] },
    source: { ...context.source, files: ['/fixture/App.vue'] },
    documents: [{ file: '/fixture/App.vue', language: 'vue', text: '<template />', blocks: [], errors: [] }]
  }
  const observed: string[][] = []
  const mutator: DoctorRulePack = { name: 'mutator', rules: [{ code: 'mutator/rule', title: 'Mutator', description: 'Example' }],
    run(snapshot) {
      snapshot.source.files.splice(0)
      snapshot.targetFiles!.files.splice(0)
      snapshot.documents![0]!.text = 'changed'
      return { diagnostics: [], skippedChecks: [] }
    }
  }
  const observer: DoctorRulePack = { name: 'observer', rules: [{ code: 'observer/rule', title: 'Observer', description: 'Example' }],
    run(snapshot) {
      observed.push([...snapshot.source.files, ...snapshot.targetFiles!.files, snapshot.documents![0]!.text])
      return { diagnostics: [], skippedChecks: [] }
    }
  }
  await runRulePacks([mutator, observer], input)
  await runRulePacks([observer, mutator], input)
  expect(observed).toEqual([
    ['/fixture/App.vue', '/fixture/App.vue', '<template />'],
    ['/fixture/App.vue', '/fixture/App.vue', '<template />']
  ])
  expect(input.source.files).toEqual(['/fixture/App.vue'])
})

function acceptancePack(): DoctorRulePack {
  return {
    name: 'acceptance',
    rules: [{ code: 'acceptance/date-range', title: 'Date range order', description: 'Exercise both selection orders.', verification: 'runtime' }],
    run: () => ({ diagnostics: [], skippedChecks: [] })
  }
}

function contextWithVue(version: string | undefined, source: 'installed' | 'declared' = 'installed'): DoctorRulePackContext {
  if (!version) return context
  return {
    ...context,
    inventory: {
      ...context.inventory,
      vue: {
        dependencyName: 'vue',
        canonicalName: 'vue',
        importRoots: ['vue'],
        source,
        ...(source === 'installed' ? { installedVersion: version } : { declaredVersion: version })
      }
    }
  }
}

function finding(code: string) {
  return {
    code,
    severity: 'warning' as const,
    message: `${code} diagnostic`,
    evidence: [],
    fixes: [],
    confidence: 'high' as const
  }
}

function mixedWorkspaceContext(
  versions: ReadonlyArray<{ root: string; file: string; version?: string }>
): DoctorRulePackContext {
  return {
    ...context,
    source: {
      ...context.source,
      files: versions.map((item) => item.file)
    },
    projectContext: {
      root: '/fixture',
      packages: versions.map((item) => ({
        root: item.root,
        inventory: {
          root: item.root,
          packages: {},
          ...(item.version ? {
            vue: {
              dependencyName: 'vue',
              canonicalName: 'vue',
              installedVersion: item.version,
              importRoots: ['vue'],
              source: 'installed' as const
            }
          } : {})
        },
        targetFiles: [item.file]
      })),
      applications: [],
      files: [],
      issues: []
    }
  }
}

describe('rule execution coverage', () => {
  test('unexecuted runtime acceptance prevents complete coverage even without diagnostics or skips', async () => {
    const result = await runRulePacks([acceptancePack()], context)
    expect(result.reports[0]?.coverageStatus).toBe('partial')
    expect(result.reports[0]?.checks?.[0]?.status).toBe('runtime')
  })

  test('a required evidence gap overrides an otherwise checked record', async () => {
    const pack = acceptancePack()
    pack.run = () => ({
      diagnostics: [],
      checks: [{ ruleCode: 'acceptance/date-range', status: 'checked' }],
      skippedChecks: [{ ruleCode: 'acceptance/date-range', required: true, reason: 'missing-capability', evidence: [{ kind: 'runtime', message: 'The end-first interaction was not observed.' }] }]
    })
    const result = await runRulePacks([pack], context)
    expect(result.reports[0]?.coverageStatus).toBe('partial')
    expect(result.reports[0]?.checks?.[0]).toMatchObject({ status: 'unavailable', reason: 'The end-first interaction was not observed.' })
  })

  test('explicitly disabled packs retain disabled metadata without executing', async () => {
    const pack = acceptancePack()
    pack.run = () => { throw new Error('A disabled pack must not execute.') }
    const result = await runRulePacks([pack], { ...context, rules: { 'acceptance/date-range': 'off' } })
    expect(result.reports[0]).toMatchObject({ coverageStatus: 'complete', checks: [{ ruleCode: 'acceptance/date-range', status: 'disabled' }] })
    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([])
  })

  test('missing static execution evidence cannot become complete through an empty checks array', async () => {
    const pack = acceptancePack()
    pack.rules = [{ ...pack.rules[0]!, verification: 'static' }]
    pack.run = () => ({ diagnostics: [], skippedChecks: [], checks: [] })
    const result = await runRulePacks([pack], context)
    expect(result.reports[0]?.coverageStatus).toBe('partial')
    expect(result.reports[0]?.checks?.[0]?.status).toBe('unavailable')
  })

  test('conflicting duplicate records cannot hide unavailable evidence by ordering', async () => {
    const pack = acceptancePack()
    pack.run = () => ({ diagnostics: [], skippedChecks: [], checks: [
      { ruleCode: 'acceptance/date-range', status: 'unavailable' },
      { ruleCode: 'acceptance/date-range', status: 'checked' }
    ] })
    await expect(runRulePacks([pack], context)).rejects.toThrow('repeated check status')
  })

  test('supports default-off metadata without changing legacy or emitted severity behavior', async () => {
    let executions = 0
    const pack: DoctorRulePack = {
      name: 'metadata',
      rules: [{
        code: 'metadata/opt-in',
        title: 'Opt-in check',
        description: 'Only runs when configured.',
        defaultEnabled: false,
        defaultSeverity: 'info'
      }],
      run(packContext) {
        executions++
        expect(packContext.rules['metadata/opt-in']).toBe('warning')
        return {
          diagnostics: [{
            code: 'metadata/opt-in',
            severity: 'error',
            message: 'Contextual severity from the pack.',
            evidence: [],
            fixes: [],
            confidence: 'high'
          }],
          skippedChecks: []
        }
      }
    }

    const disabled = await runRulePacks([pack], context)
    expect(executions).toBe(0)
    expect(disabled.reports[0]?.checks).toEqual([
      { ruleCode: 'metadata/opt-in', status: 'disabled' }
    ])

    const enabled = await runRulePacks([pack], {
      ...context,
      rules: { 'metadata/opt-in': 'warning' }
    })
    expect(executions).toBe(1)
    expect(enabled.diagnostics[0]?.severity).toBe('error')
  })

  test('rejects diagnostics with identities not declared by their pack', async () => {
    const pack = acceptancePack()
    pack.run = () => ({
      diagnostics: [{
        code: 'other/undeclared',
        severity: 'warning',
        message: 'Undeclared diagnostic.',
        evidence: [],
        fixes: [],
        confidence: 'high'
      }],
      skippedChecks: []
    })
    await expect(runRulePacks([pack], context)).rejects.toThrow(
      'returned undeclared rule other/undeclared'
    )
  })

  test('runs Vue-applicable packs and distinguishes version mismatch from missing version evidence', async () => {
    let executions = 0
    const pack: DoctorRulePack = {
      name: 'versioned',
      rules: [{
        code: 'versioned/vue2',
        title: 'Vue 2 rule',
        description: 'Runs only with Vue 2 evidence.',
        applicability: { vue: { only: 2 } }
      }],
      run: () => {
        executions++
        return {
          diagnostics: [finding('versioned/vue2')],
          skippedChecks: [],
          checks: [{ ruleCode: 'versioned/vue2', status: 'checked' }]
        }
      }
    }

    const vue2 = await runRulePacks([pack], contextWithVue('^2.7.0', 'declared'))
    expect(executions).toBe(1)
    expect(vue2.diagnostics).toHaveLength(1)
    expect(vue2.reports[0]).toMatchObject({ coverageStatus: 'complete', checks: [{ status: 'checked' }] })

    const vue3 = await runRulePacks([pack], contextWithVue('3.5.39'))
    expect(executions).toBe(1)
    expect(vue3.diagnostics).toEqual([])
    expect(vue3.reports[0]).toMatchObject({
      coverageStatus: 'complete',
      checks: [{ ruleCode: 'versioned/vue2', status: 'not-applicable' }]
    })

    for (const unknownContext of [context, contextWithVue('workspace:*')]) {
      const unknown = await runRulePacks([pack], unknownContext)
      expect(executions).toBe(1)
      expect(unknown.reports[0]).toMatchObject({
        coverageStatus: 'partial',
        checks: [{
          ruleCode: 'versioned/vue2',
          status: 'unavailable',
          reason: expect.stringContaining('Vue version evidence is unavailable')
        }]
      })
    }
  })

  test('runs a mixed pack once and filters inactive findings while reporting metadata-only checks', async () => {
    let executions = 0
    const codes = ['mixed/vue2', 'mixed/vue3', 'mixed/opt-in'] as const
    const pack: DoctorRulePack = {
      name: 'mixed',
      rules: [
        { code: codes[0], title: 'Vue 2', description: 'Vue 2 only.', applicability: { vue: { only: 2 } } },
        { code: codes[1], title: 'Vue 3', description: 'Vue 3 only.', applicability: { vue: { only: 3 } } },
        { code: codes[2], title: 'Opt in', description: 'Disabled by default.', defaultEnabled: false }
      ],
      run(packContext) {
        executions++
        expect(packContext.rules).toMatchObject({
          'mixed/vue2': 'off',
          'mixed/opt-in': 'off'
        })
        return {
          diagnostics: codes.map(finding),
          skippedChecks: codes.map((ruleCode) => ({
            ruleCode,
            required: false,
            reason: 'missing-capability' as const,
            evidence: []
          }))
        }
      }
    }

    const vue3 = await runRulePacks([pack], contextWithVue('3.5.39'))
    expect(executions).toBe(1)
    expect(vue3.diagnostics.map((item) => item.code)).toEqual(['mixed/vue3'])
    expect(vue3.skippedChecks.map((item) => item.ruleCode)).toEqual(['mixed/vue3'])
    expect(vue3.reports[0]).toMatchObject({
      coverageStatus: 'partial',
      checks: [
        { ruleCode: 'mixed/vue2', status: 'not-applicable' },
        { ruleCode: 'mixed/vue3', status: 'unavailable' },
        { ruleCode: 'mixed/opt-in', status: 'disabled' }
      ]
    })

    const unknown = await runRulePacks([pack], context)
    expect(executions).toBe(1)
    expect(unknown.reports[0]).toMatchObject({
      coverageStatus: 'partial',
      checks: [
        { ruleCode: 'mixed/vue2', status: 'unavailable' },
        { ruleCode: 'mixed/vue3', status: 'unavailable' },
        { ruleCode: 'mixed/opt-in', status: 'disabled' }
      ]
    })
  })

  test('keeps mixed coverage partial when an executed pack also has unknown Vue applicability', async () => {
    const pack: DoctorRulePack = {
      name: 'mixed-unknown',
      rules: [
        { code: 'mixed-unknown/legacy', title: 'Legacy', description: 'Always runnable.' },
        {
          code: 'mixed-unknown/versioned',
          title: 'Versioned',
          description: 'Requires Vue 3 evidence.',
          applicability: { vue: { only: 3 } }
        }
      ],
      run(packContext) {
        expect(packContext.rules['mixed-unknown/versioned']).toBe('off')
        return {
          diagnostics: [],
          skippedChecks: [],
          checks: [{ ruleCode: 'mixed-unknown/legacy', status: 'checked' }]
        }
      }
    }

    const result = await runRulePacks([pack], context)
    expect(result.reports[0]).toMatchObject({
      coverageStatus: 'partial',
      checks: [
        { ruleCode: 'mixed-unknown/legacy', status: 'checked' },
        { ruleCode: 'mixed-unknown/versioned', status: 'unavailable' }
      ]
    })
  })

  test('reads source extensions only for packs with a runnable rule', () => {
    const packs: DoctorRulePack[] = [
      {
        name: 'only-two',
        sourceExtensions: ['.md'],
        rules: [{ code: 'only-two/rule', title: 'Vue 2', description: 'Vue 2.', applicability: { vue: { only: 2 } } }],
        run: () => ({ diagnostics: [], skippedChecks: [] })
      },
      {
        name: 'mixed-extension',
        sourceExtensions: ['.txt', '.md'],
        rules: [
          { code: 'mixed-extension/two', title: 'Vue 2', description: 'Vue 2.', applicability: { vue: { only: 2 } } },
          { code: 'mixed-extension/three', title: 'Vue 3', description: 'Vue 3.', applicability: { vue: { only: 3 } } }
        ],
        run: () => ({ diagnostics: [], skippedChecks: [] })
      },
      {
        name: 'legacy-extension',
        sourceExtensions: ['.json'],
        rules: [{ code: 'legacy-extension/rule', title: 'Legacy', description: 'No metadata.' }],
        run: () => ({ diagnostics: [], skippedChecks: [] })
      },
      {
        name: 'opt-in-extension',
        sourceExtensions: ['.css'],
        rules: [{ code: 'opt-in-extension/rule', title: 'Opt in', description: 'Disabled.', defaultEnabled: false }],
        run: () => ({ diagnostics: [], skippedChecks: [] })
      }
    ]

    expect(selectRulePackSourceExtensions(packs, {}, '3.5.39')).toEqual(['.txt', '.md', '.json'])
    expect(selectRulePackSourceExtensions(packs, {}, '2.7.16')).toEqual(['.md', '.txt', '.json'])
    expect(selectRulePackSourceExtensions(packs, {}, undefined)).toEqual(['.json'])
    expect(selectRulePackSourceExtensions(packs, { 'opt-in-extension/rule': 'info' }, undefined))
      .toEqual(['.json', '.css'])
    expect(selectRulePackSourceExtensions(packs, {}, {
      files: ['/fixture/apps/modern/src/App.vue'],
      vueVersions: { '/fixture/apps/modern/src/App.vue': '3.5.39' }
    })).toEqual(['.txt', '.md', '.json'])
  })

  test('selects versioned rules per owning package and filters findings from incompatible files', async () => {
    const vue2File = '/fixture/apps/legacy/src/App.vue'
    const vue3File = '/fixture/apps/modern/src/App.vue'
    const pack: DoctorRulePack = {
      name: 'workspace',
      rules: [{
        code: 'workspace/vue2',
        title: 'Vue 2',
        description: 'Vue 2 only.',
        applicability: { vue: { only: 2 } }
      }, {
        code: 'workspace/vue3',
        title: 'Vue 3',
        description: 'Vue 3 only.',
        applicability: { vue: { only: 3 } }
      }],
      run(packContext) {
        expect(packContext.rules).not.toMatchObject({
          'workspace/vue2': 'off',
          'workspace/vue3': 'off'
        })
        return {
          diagnostics: [
            { ...finding('workspace/vue2'), file: vue2File },
            { ...finding('workspace/vue2'), file: vue3File },
            { ...finding('workspace/vue3'), file: vue2File },
            { ...finding('workspace/vue3'), file: vue3File }
          ],
          skippedChecks: [],
          checks: [
            { ruleCode: 'workspace/vue2', status: 'checked' },
            { ruleCode: 'workspace/vue3', status: 'checked' }
          ]
        }
      }
    }

    const result = await runRulePacks([pack], mixedWorkspaceContext([
      { root: '/fixture/apps/legacy', file: vue2File, version: '2.7.16' },
      { root: '/fixture/apps/modern', file: vue3File, version: '3.5.39' }
    ]))

    expect(result.diagnostics.map((item) => [item.code, item.file])).toEqual([
      ['workspace/vue2', vue2File],
      ['workspace/vue3', vue3File]
    ])
    expect(result.reports[0]).toMatchObject({
      coverageStatus: 'complete',
      checks: [
        { ruleCode: 'workspace/vue2', status: 'checked' },
        { ruleCode: 'workspace/vue3', status: 'checked' }
      ]
    })
  })

  test('resolves relative diagnostic and required skip paths against their consuming package', async () => {
    const legacy = 'apps/legacy/src/App.vue'
    const modern = 'apps/modern/src/App.vue'
    const project = mixedWorkspaceContext([
      { root: '/fixture/apps/legacy', file: `/fixture/${legacy}`, version: '2.7.16' },
      { root: '/fixture/apps/modern', file: `/fixture/${modern}`, version: '3.5.39' }
    ])
    project.inventory = contextWithVue('3.5.39').inventory
    const pack: DoctorRulePack = {
      name: 'relative',
      rules: [{ code: 'relative/vue2', title: 'Legacy', description: 'Vue 2 only.', applicability: { vue: { only: 2 } } }],
      run: () => ({
        diagnostics: [legacy, modern].map(file => ({ ...finding('relative/vue2'), file })),
        skippedChecks: [legacy, modern].map(file => ({ ruleCode: 'relative/vue2', file, required: true, reason: 'missing-capability' as const, evidence: [] })),
        checks: [{ ruleCode: 'relative/vue2', status: 'checked' }]
      })
    }
    const result = await runRulePacks([pack], project)
    expect(result.diagnostics.map(item => item.file)).toEqual([legacy])
    expect(result.skippedChecks.map(item => item.file)).toEqual([legacy])
    expect(result.reports[0]).toMatchObject({ coverageStatus: 'partial', checks: [{ status: 'unavailable' }] })
  })

  test('runs known-applicable targets but reports partial applicability when another target version is unknown', async () => {
    const knownFile = '/fixture/apps/known/src/App.vue'
    const unknownFile = '/fixture/apps/unknown/src/App.vue'
    const pack: DoctorRulePack = {
      name: 'partial-workspace',
      rules: [{
        code: 'partial-workspace/vue3',
        title: 'Vue 3',
        description: 'Vue 3 only.',
        applicability: { vue: { only: 3 } }
      }],
      run: () => ({
        diagnostics: [
          { ...finding('partial-workspace/vue3'), file: knownFile },
          { ...finding('partial-workspace/vue3'), file: unknownFile }
        ],
        skippedChecks: [],
        checks: [{ ruleCode: 'partial-workspace/vue3', status: 'checked' }]
      })
    }

    const result = await runRulePacks([pack], mixedWorkspaceContext([
      { root: '/fixture/apps/known', file: knownFile, version: '3.5.39' },
      { root: '/fixture/apps/unknown', file: unknownFile }
    ]))

    expect(result.diagnostics.map((item) => item.file)).toEqual([knownFile])
    expect(result.reports[0]).toMatchObject({
      coverageStatus: 'partial',
      checks: [{
        ruleCode: 'partial-workspace/vue3',
        status: 'partial',
        reason: expect.stringContaining('some target files')
      }]
    })
  })

  test('passes additive project and target context to external packs', async () => {
    const projectContext = mixedWorkspaceContext([{
      root: '/fixture/apps/modern',
      file: '/fixture/apps/modern/src/App.vue',
      version: '3.5.39'
    }]).projectContext!
    const targetFiles = {
      root: '/fixture',
      files: ['/fixture/apps/modern/src/App.vue'],
      requestedFiles: undefined,
      issues: []
    }
    const pack = acceptancePack()
    pack.run = (packContext) => {
      expect(packContext.projectContext).toEqual(projectContext)
      expect(packContext.targetFiles).toEqual(targetFiles)
      expect(packContext.projectContext).not.toBe(projectContext)
      expect(packContext.targetFiles).not.toBe(targetFiles)
      return { diagnostics: [], skippedChecks: [] }
    }
    await runRulePacks([pack], { ...context, projectContext, targetFiles })
  })

  test('keeps metadata-free legacy packs without check records', async () => {
    const pack: DoctorRulePack = {
      name: 'legacy',
      rules: [{ code: 'legacy/rule', title: 'Legacy rule', description: 'No registry metadata.' }],
      run: () => ({ diagnostics: [], skippedChecks: [] })
    }

    const result = await runRulePacks([pack], context)
    expect(result.reports[0]).toEqual({
      name: 'legacy',
      rules: pack.rules,
      coverageStatus: 'complete'
    })
  })
})
