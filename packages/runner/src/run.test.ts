import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runDoctor, summarizeDoctorReport } from './index.js'
import {
  shouldFailDoctorRun,
  type DoctorReport,
  type DoctorRulePack
} from '@vue-doctor/core'

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function reportForPolicy(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    project: { root: '/fixture', vueFramework: 'unknown', uiLibraries: [] },
    inventory: { root: '/fixture', packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 0, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics: [],
    ...overrides
  }
}

describe('report policy', () => {
  test('required skipped checks prevent a clean result', () => {
    const summary = summarizeDoctorReport(reportForPolicy({
      skippedChecks: [{
        ruleCode: 'component-event-payload',
        required: true,
        reason: 'partial-contract',
        evidence: []
      }]
    }))

    expect(summary).toMatchObject({
      isClean: false,
      skippedCheckCount: 1,
      requiredSkippedCheckCount: 1
    })
  })

  test('non-required skipped checks do not block complete clean coverage', () => {
    const summary = summarizeDoctorReport(reportForPolicy({
      skippedChecks: [{
        ruleCode: 'nuxt-only-check',
        required: false,
        reason: 'unsupported-framework',
        evidence: []
      }]
    }))

    expect(summary).toMatchObject({
      isClean: true,
      skippedCheckCount: 1,
      requiredSkippedCheckCount: 0
    })
  })
})

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-'))
  const libraryRoot = join(root, 'node_modules/example-ui')
  const utilityRoot = join(root, 'node_modules/plain-utility')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await mkdir(utilityRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      'example-ui': '1.2.0',
      'plain-utility': '^4.0.0'
    }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    'web-types': './web-types.json'
  })
  await writeJson(join(libraryRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        'vue-components': [
          {
            name: 'ElDatePickerV2',
            events: []
          }
        ]
      }
    }
  })
  await writeJson(join(utilityRoot, 'package.json'), {
    name: 'plain-utility',
    version: '4.0.1'
  })
  await writeFile(
    join(root, 'src/App.vue'),
    `<script setup>
import { ElDatePickerV2 } from 'example-ui'
</script>
<template>
  <ElDatePickerV2 @missing-change="onMissing" />
</template>
`,
    'utf8'
  )

  return root
}

async function createDeclarationOnlyProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-declarations-'))
  const libraryRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      'example-ui': '1.2.0'
    }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    types: './index.d.ts',
    'web-types': './web-types.json',
    vetur: {
      tags: './tags.json',
      attributes: './attributes.json'
    }
  })
  await writeJson(join(libraryRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        elements: []
      }
    }
  })
  await writeJson(join(libraryRoot, 'tags.json'), {})
  await writeJson(join(libraryRoot, 'attributes.json'), {})
  await writeFile(
    join(libraryRoot, 'index.d.ts'),
    `export declare const ExampleButton: {
  new (): {
    $props: {
      disabled?: boolean
      onClick?: (event: MouseEvent) => void
    }
    $emit: {
      (event: 'click', value: MouseEvent): void
    }
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(root, 'src/App.vue'),
    `<script setup lang="ts">
import { ExampleButton } from 'example-ui'

function onGhost() {}
</script>
<template>
  <ExampleButton ghost-prop @ghost="onGhost" />
</template>
`,
    'utf8'
  )

  return root
}

async function createUnresolvedHandlerProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-unresolved-handler-'))
  const libraryRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: { 'example-ui': '1.2.0' }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    types: './index.d.ts'
  })
  await writeFile(join(libraryRoot, 'index.d.ts'), `export declare const ExampleButton: {
  new (): {
    $props: {}
    $emit: {
      (event: 'change', value: string): void
    }
  }
}
`, 'utf8')
  await writeFile(join(root, 'src/App.vue'), `<script setup lang="ts">
import { ExampleButton } from 'example-ui'

const dynamicHandlers = {
  change(value: string) {}
}
</script>
<template>
  <ExampleButton @change="dynamicHandlers.change" />
</template>
`, 'utf8')

  return root
}

async function createAliasedSubpathProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-alias-'))
  const libraryRoot = join(root, 'node_modules/@fixture/ui-alias')

  await mkdir(join(root, 'src/shared'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      '@fixture/ui-alias': 'npm:@fixture/ui@1.2.3'
    }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: '@fixture/ui',
    version: '1.2.3',
    exports: {
      './button': { types: './button.d.ts' }
    }
  })
  await writeFile(join(libraryRoot, 'button.d.ts'), `export declare const ExampleButton: {
  new (): {
    $props: {
      disabled?: boolean
    }
  }
}
`, 'utf8')
  await writeFile(join(root, 'src/shared/App.vue'), `<script setup lang="ts">
import { ExampleButton } from '@fixture/ui-alias/button'
</script>
<template>
  <ExampleButton ghost-prop />
</template>
`, 'utf8')

  return root
}

async function createVue27ConfiguredUiProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-vue27-ui-'))
  const vueRoot = join(root, 'node_modules/vue')
  const libraryRoot = join(root, 'node_modules/transitive-ui')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(vueRoot, { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: { vue: '^2.7.0' }
  })
  await writeJson(join(root, 'vue-doctor.config.json'), {
    ui: {
      autoDetect: false,
      libraries: [{ package: 'transitive-ui', aliases: ['@ui'] }]
    }
  })
  await writeJson(join(vueRoot, 'package.json'), {
    name: 'vue',
    version: '2.7.16'
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'transitive-ui',
    version: '4.2.0',
    'web-types': './web-types.json'
  })
  await writeJson(join(libraryRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'transitive-ui',
    version: '4.2.0',
    contributions: {
      html: {
        'vue-components': [{
          name: 'ExampleButton',
          events: [{ name: 'click' }]
        }]
      }
    }
  })
  await writeFile(join(root, 'src/App.vue'), `<script setup>
import { ExampleButton } from '@ui'
</script>
<template>
  <ExampleButton @missing="onMissing" />
  <div @click.native="onClick">{{ message | upper }}</div>
</template>
`, 'utf8')

  return root
}

describe('default Doctor runner', () => {
  test('rejects an unknown configured rule code even when it is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-unknown-rule-'))
    await writeJson(join(root, 'package.json'), {})

    await expect(runDoctor({
      root,
      config: { rules: { 'vue-typo-rule': 'off' } }
    })).rejects.toThrow('Unknown Doctor rule code')
  })

  test('distinguishes a valid empty scope from a failed source discovery target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-discovery-'))
    await writeJson(join(root, 'package.json'), {})

    const empty = await runDoctor({ root, scope: [] })
    const missing = await runDoctor({ root, scope: 'missing' })

    expect(empty.coverage.source).toEqual({
      status: 'complete',
      scannedFileCount: 0,
      failedFiles: []
    })
    expect(missing.coverage.source).toEqual({
      status: 'partial',
      scannedFileCount: 0,
      failedFiles: [],
      discoveryIssues: [expect.objectContaining({
        kind: 'scope-not-found',
        path: join(root, 'missing')
      })]
    })
  })

  test('intersects a file allowlist with config scope while explicit scope still overrides config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-file-allowlist-'))
    const scopedFile = join(root, 'src/scoped/Broken.vue')
    const otherFile = join(root, 'src/other/App.vue')
    await mkdir(join(root, 'src/scoped'), { recursive: true })
    await mkdir(join(root, 'src/other'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    await writeJson(join(root, 'doctor.config.json'), { scope: 'src/scoped' })
    await writeFile(scopedFile, '<script setup lang="ts">const = broken</script><template><div /></template>')
    await writeFile(otherFile, '<template><main /></template>')

    const configured = await runDoctor({ root, files: [scopedFile, otherFile] })
    expect(configured.coverage.source).toMatchObject({
      status: 'partial',
      scannedFileCount: 1,
      failedFiles: [expect.objectContaining({ file: scopedFile })]
    })

    const overridden = await runDoctor({
      root,
      scope: 'src/other',
      files: [scopedFile, otherFile]
    })
    expect(overridden.coverage.source).toEqual({
      status: 'complete',
      scannedFileCount: 1,
      failedFiles: []
    })

    const empty = await runDoctor({ root, files: [] })
    expect(empty.coverage.source).toEqual({
      status: 'complete',
      scannedFileCount: 0,
      failedFiles: []
    })

    await writeJson(join(root, 'doctor.config.json'), { scope: 'missing' })
    const invalid = await runDoctor({ root, files: [] })
    expect(invalid.coverage.source).toMatchObject({
      status: 'partial',
      scannedFileCount: 0,
      failedFiles: [],
      discoveryIssues: [expect.objectContaining({
        kind: 'scope-not-found',
        path: join(root, 'missing')
      })]
    })
  })

  test('limits external rule-pack documents to custom-extension files inside scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-document-allowlist-'))
    const cssFile = join(root, 'assets/theme.css')
    const htmlFile = join(root, 'assets/shell.html')
    const outsideScope = join(root, 'other/ignored.css')
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(root, 'other'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    await writeFile(cssFile, '.theme {}')
    await writeFile(htmlFile, '<main></main>')
    await writeFile(outsideScope, '.ignored {}')
    let documentFiles: string[] = []
    const pack = {
      name: 'assets',
      sourceExtensions: ['.css', '.html'],
      rules: [{ code: 'assets/check', title: 'Assets', description: 'Checks assets.' }],
      run(context) {
        documentFiles = context.documents?.map((document) => document.file) ?? []
        return { diagnostics: [], skippedChecks: [] }
      }
    } satisfies DoctorRulePack

    await runDoctor({
      root,
      files: ['assets/theme.css', htmlFile, outsideScope],
      config: { scope: 'assets', gitAttribution: false, rulePacks: [pack] }
    })

    expect(documentFiles).toEqual([htmlFile, cssFile])
  })

  test('stabilizes diagnostics, evidence, skips and serialized report order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-stable-'))
    await writeJson(join(root, 'package.json'), {})
    const file = join(root, 'same.vue')
    let reverseOutput = false
    const pack = {
      name: 'stable',
      rules: [
        { code: 'stable/a', title: 'A', description: 'A rule', domain: 'interaction' as const },
        { code: 'stable/b', title: 'B', description: 'B rule', domain: 'interaction' as const }
      ],
      run() {
        const sharedEvidence = () => [
          { kind: 'z-kind', file, line: 2 },
          { kind: 'same-kind', file, line: 1, git: { commit: 'z', authorName: 'Z' } },
          { kind: 'a-kind', file, line: 1 },
          { kind: 'same-kind', file, line: 1, git: { commit: 'a', authorName: 'A' } }
        ]
        const diagnostics = [
          {
            code: 'stable/b', severity: 'warning' as const, confidence: 'high' as const,
            message: 'same', file, fixes: [{ title: 'Alpha' }], evidence: sharedEvidence()
          },
          {
            code: 'stable/a', severity: 'warning' as const, confidence: 'low' as const,
            message: 'same', file, fixes: [{ title: 'Alpha' }], evidence: sharedEvidence()
          },
          {
            code: 'stable/a', severity: 'warning' as const, confidence: 'high' as const,
            message: 'same', file, fixes: [{ title: 'Zebra' }], evidence: sharedEvidence()
          },
          {
            code: 'stable/a', severity: 'warning' as const, confidence: 'high' as const,
            message: 'same', file, fixes: [{ title: 'Alpha' }], evidence: sharedEvidence()
          }
        ]
        const skippedChecks = [
          { ruleCode: 'stable/b', required: false, reason: 'missing-capability' as const, file, evidence: [{ kind: 'a-kind', file }] },
          { ruleCode: 'stable/a', required: true, reason: 'partial-contract' as const, file, evidence: [{ kind: 'b-kind', file }] },
          { ruleCode: 'stable/a', required: false, reason: 'missing-capability' as const, file, evidence: [{ kind: 'z-kind', file }] },
          { ruleCode: 'stable/a', required: false, reason: 'missing-capability' as const, file, evidence: [{ kind: 'a-kind', file }] }
        ]
        reverseOutput = !reverseOutput
        return reverseOutput
          ? { diagnostics: diagnostics.reverse(), skippedChecks: skippedChecks.reverse() }
          : { diagnostics, skippedChecks }
      }
    }

    const first = await runDoctor({ root, scope: [], config: { gitAttribution: false, rulePacks: [pack] } })
    const second = await runDoctor({ root, scope: [], config: { gitAttribution: false, rulePacks: [pack] } })

    expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'stable/a', 'stable/a', 'stable/a', 'stable/b'
    ])
    expect(first.diagnostics[0]).toMatchObject({ domain: 'interaction', tags: [], rulePack: 'stable' })
    expect(first.diagnostics.slice(0, 3).map((diagnostic) => diagnostic.confidence))
      .toEqual(['high', 'high', 'low'])
    expect(first.diagnostics.slice(0, 2).map((diagnostic) => diagnostic.fixes[0]?.title))
      .toEqual(['Alpha', 'Zebra'])
    expect(first.diagnostics[0]?.evidence.map((evidence) => evidence.kind)).toEqual([
      'a-kind', 'same-kind', 'same-kind', 'z-kind'
    ])
    expect(first.diagnostics[0]?.evidence.filter((evidence) => evidence.kind === 'same-kind')
      .map((evidence) => evidence.git?.commit)).toEqual(['a', 'z'])
    expect(first.skippedChecks?.map((check) => check.ruleCode)).toEqual([
      'stable/a', 'stable/a', 'stable/a', 'stable/b'
    ])
    expect(first.skippedChecks?.slice(0, 2).map((check) => check.evidence[0]?.kind))
      .toEqual(['a-kind', 'z-kind'])
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  test('records required Vue checks skipped by a failed source block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-skipped-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    await writeFile(join(root, 'src/App.vue'), '<script setup lang="ts">const = broken</script><template><div /></template>', 'utf8')

    const report = await runDoctor({ root })

    expect(report.skippedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: 'vue-watch-require-cleanup', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-derived-state', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-reactive-property', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-self-mutation', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-async-stale-write', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-shallow-ref-nested-mutation', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-reactive-reassignment', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-readonly-mutation', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-shallow-reactive-nested-mutation', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-detached-effect-scope-require-stop', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-custom-ref-incomplete-contract', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-to-refs-plain-object', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-lifecycle-require-cleanup', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-require-post-flush', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-watch-effect-await-read', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-lifecycle-no-mutation-in-onupdated', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-ssr-no-browser-api-in-setup', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
      expect.objectContaining({ ruleCode: 'vue-ssr-no-random-or-local-time-render', required: true, reason: 'parse-failed', file: join(root, 'src/App.vue') }),
    ]))
  })

  test('keeps eslint-overlapping Vue rules opt-in while preserving explicit policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-eslint-overlap-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '3.5.39' } })
    await writeFile(join(root, 'src/App.vue'), '<template><article v-html="content" /></template>', 'utf8')

    const defaultReport = await runDoctor({ root })
    const optedInReport = await runDoctor({
      root,
      config: { rules: { 'vue-security-restrict-v-html': 'warning' } }
    })
    const explicitlyDisabledReport = await runDoctor({
      root,
      config: { rules: { 'vue-security-restrict-v-html': 'off' } }
    })

    expect(defaultReport.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-security-restrict-v-html'
    )
    expect(optedInReport.diagnostics).toEqual([
      expect.objectContaining({
        code: 'vue-security-restrict-v-html',
        severity: 'warning'
      })
    ])
    expect(explicitlyDisabledReport.diagnostics).toEqual([])
  })
  test('does not assume Vue 3 for nested projects when the root version is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runner-unknown-version-'))
    await mkdir(join(root, 'packages/vue2-app/src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { private: true })
    await writeJson(join(root, 'packages/vue2-app/package.json'), {
      dependencies: { vue: '2.7.16' }
    })
    await writeFile(join(root, 'packages/vue2-app/src/App.vue'), `<script>
export default {
  async setup() {
    await Promise.resolve()
    return {}
  }
}
</script><template><div /></template>`, 'utf8')

    const report = await runDoctor({ root })

    expect(report.project.vueFramework).toBe('unknown')
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-async-setup-without-suspense'
    )
  })


  test('combines inventory, source usage, component-library evidence, and rule diagnostics', async () => {
    const root = await createProject()

    const report = await runDoctor({ root })

    expect(report.project.root).toBe(root)
    expect(report.inventory.packages['example-ui']).toMatchObject({
      declaredVersion: '1.2.0',
      installedVersion: '1.2.3'
    })
    expect(report.diagnostics).toEqual([])
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-unsupported',
      required: true,
      reason: 'missing-capability',
      file: join(root, 'src/App.vue')
    }))
    expect(report.domainCoverage).toContainEqual(expect.objectContaining({
      domain: 'component-library',
      status: 'partial',
      unavailableCheckCount: expect.any(Number)
    }))
    expect(report.domainCoverage?.find((domain) => domain.domain === 'component-library')?.unavailableCheckCount)
      .toBeGreaterThan(0)
  })

  test('lowers coverage and fails the incomplete-coverage gate for enabled required component skips', async () => {
    const root = await createProject()
    const gateConfig = { failOnIncompleteCoverage: true }

    const report = await runDoctor({ root, config: gateConfig })

    expect(report.coverage.status).toBe('partial')
    expect(report.coverage.componentLibraries).toEqual([
      expect.objectContaining({
        status: 'partial',
        problems: expect.arrayContaining([
          expect.objectContaining({
            code: 'component-library-contracts-partial',
            message: expect.stringContaining('component-event-unsupported')
          })
        ])
      })
    ])
    expect(report.domainCoverage).toContainEqual(expect.objectContaining({
      domain: 'component-library',
      status: 'partial',
      unavailableCheckCount: expect.any(Number)
    }))
    expect(report.domainCoverage?.find((domain) => domain.domain === 'component-library')?.unavailableCheckCount)
      .toBeGreaterThan(0)
    expect(shouldFailDoctorRun({
      diagnostics: report.diagnostics,
      coverageStatus: report.coverage.status,
      config: gateConfig
    })).toBe(true)

    const disabled = await runDoctor({
      root,
      config: {
        ...gateConfig,
        rules: {
          'component-event-unsupported': 'off',
          'component-prop-required-missing': 'off'
        }
      }
    })

    expect(disabled.skippedChecks?.filter((check) => check.ruleCode.startsWith('component-'))).toEqual([])
    expect(disabled.coverage.status).toBe('complete')
    expect(disabled.coverage.componentLibraries[0]).toMatchObject({
      status: 'complete',
      problems: []
    })
    expect(shouldFailDoctorRun({
      diagnostics: disabled.diagnostics,
      coverageStatus: disabled.coverage.status,
      config: gateConfig
    })).toBe(false)
  })

  test('attributes unresolved handlers to the available source and contract evidence', async () => {
    const root = await createUnresolvedHandlerProject()

    const report = await runDoctor({ root, config: { gitAttribution: false } })
    const library = report.coverage.componentLibraries[0]
    const problem = library?.problems.find((item) => (
      item.code === 'component-library-contracts-partial'
      && item.message.includes('component-event-payload-changed')
    ))

    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-payload-changed',
      required: true,
      reason: 'missing-capability'
    }))
    expect(report.coverage.status).toBe('partial')
    expect(library).toMatchObject({
      status: 'partial',
      dimensions: expect.objectContaining({ events: 'known' })
    })
    expect(problem).toMatchObject({
      message: 'Required component checks could not run with the available source and installed contract evidence: component-event-payload-changed.',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: 'source-event-listener',
          message: 'The handler or payload signature for event "change" could not be resolved.'
        }),
        expect.objectContaining({
          kind: 'component-contract',
          message: 'Installed component contract evidence consulted for this check.'
        })
      ])
    })
    expect(problem?.evidence.map((evidence) => evidence.message)).not.toContain(
      'Installed component contract evidence is incomplete for this check.'
    )
    expect(report.domainCoverage).toContainEqual(expect.objectContaining({
      domain: 'component-library',
      status: 'partial',
      unavailableCheckCount: 1
    }))
  })

  test('uses declarations when installed component-library metadata is empty', async () => {
    const root = await createDeclarationOnlyProject()

    const report = await runDoctor({ root })

    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report)

    expect(report.coverage.status).toBe('partial')
    expect(report.coverage.componentLibraries[0]).toMatchObject({
      package: expect.objectContaining({ canonicalName: 'example-ui' }),
      status: 'partial',
      detectedUsageCount: 1,
      matchedUsageCount: 1,
      dimensions: expect.objectContaining({ props: 'partial' })
    })
    expect(report.diagnostics).toEqual([])
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-unsupported',
      required: true,
      reason: 'missing-capability'
    }))
    expect(report.diagnostics.map((item) => item.code)).not.toContain(
      'component-library-contracts-missing'
    )
  })

  test('uses an aliased package identity and observed declaration subpath', async () => {
    const root = await createAliasedSubpathProject()

    const report = await runDoctor({
      root,
      scope: 'src/shared',
      config: { rules: { 'component-attribute-unverified': 'info' } }
    })

    expect(report.inventory.packages['@fixture/ui-alias']).toMatchObject({
      canonicalName: '@fixture/ui',
      importRoots: ['@fixture/ui-alias', '@fixture/ui']
    })
    expect(report.coverage.componentLibraries).toEqual([
      expect.objectContaining({
        package: expect.objectContaining({ canonicalName: '@fixture/ui' }),
        status: 'partial',
        dimensions: expect.objectContaining({ props: 'partial' })
      })
    ])
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-attribute-unverified',
        severity: 'info',
        message: 'ExampleButton from @fixture/ui@1.2.3 does not declare attribute "ghost-prop", and its runtime forwarding target could not be fully verified.'
      })
    ])
  })
  test('prefers an installed npm alias when UI config names its canonical package', async () => {
    const root = await createAliasedSubpathProject()

    const report = await runDoctor({
      root,
      scope: 'src/shared',
      config: {
        ui: {
          autoDetect: false,
          libraries: ['@fixture/ui']
        }
      }
    })

    expect(report.coverage.componentLibraries).toEqual([
      expect.objectContaining({
        package: expect.objectContaining({
          dependencyName: '@fixture/ui-alias',
          canonicalName: '@fixture/ui',
          packageRoot: join(root, 'node_modules/@fixture/ui-alias'),
          source: 'installed'
        })
      })
    ])
  })

  test('uses Vue 2.7 semantics and configured UI package aliases', async () => {
    const root = await createVue27ConfiguredUiProject()

    const report = await runDoctor({ root })
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code)

    expect(report.project).toMatchObject({
      vueVersion: '2.7.16',
      vueFramework: 'vue2.7',
      uiLibraries: ['transitive-ui']
    })
    expect(report.inventory.packages['transitive-ui']).toMatchObject({
      installedVersion: '4.2.0',
      source: 'installed',
      importRoots: ['transitive-ui']
    })
    expect(report.coverage.componentLibraries[0]?.package.importRoots).toEqual([
      'transitive-ui',
      '@ui'
    ])
    expect(codes).not.toContain('component-event-unsupported')
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-unsupported',
      required: true,
      reason: 'missing-capability'
    }))
    expect(codes).not.toContain('vue-v-on-native-removed')
    expect(codes).not.toContain('vue-filters-removed')
  })

})
