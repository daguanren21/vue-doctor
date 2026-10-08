import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DoctorRulePack } from '@vue-doctor/core'
import { describe, expect, test } from 'vitest'
import { createDoctorAnalysisSession, runDoctor } from './index.js'

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('real Doctor analysis sessions', () => {
  test('reloads executable config and changed source on every completed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-real-session-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    const policy = join(root, 'policy.mjs')
    await writeFile(policy, 'export const failOn = "warning"\n')
    await writeFile(join(root, 'doctor.config.mjs'), `import { failOn } from './policy.mjs'
export default { failOn, gitAttribution: false }
`)
    const source = join(root, 'src/App.vue')
    await writeFile(source, '<script setup lang="ts">const = broken</script><template><div /></template>')
    const resolved: Array<string | undefined> = []
    const session = createDoctorAnalysisSession({
      root,
      scope: 'src',
      onConfigResolved: (config) => resolved.push(config.failOn)
    })

    const first = await session.run()
    expect(first.coverage.source.status).toBe('partial')
    expect(Object.isFrozen(first)).toBe(true)

    await writeFile(policy, 'export const failOn = "error"\n')
    await writeFile(source, '<script setup lang="ts">const valid = true</script><template><div /></template>')
    const second = await session.run()

    expect(second.coverage.source.status).toBe('complete')
    expect(resolved).toEqual(['warning', 'error'])
    const stats = session.getStats()
    expect(stats).toMatchObject({
      runsStarted: 2,
      runsCompleted: 2,
      lastRun: {
        generation: 0,
        phases: {
          config: expect.any(Number),
          sourceAnalysis: expect.any(Number),
          report: expect.any(Number)
        },
        peakRssBytes: expect.any(Number)
      },
      source: { sourceReads: 2, parseCount: 2 }
    })
    expect(stats.lastRun?.totalMilliseconds).toBeGreaterThanOrEqual(0)
    await session.close()
  })

  test('revalidates transitive component declarations after an edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-session-contract-'))
    const libraryRoot = join(root, 'node_modules/example-ui')
    const vueRoot = join(root, 'node_modules/vue')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(libraryRoot, { recursive: true })
    await mkdir(vueRoot, { recursive: true })
    await writeJson(join(root, 'package.json'), {
      dependencies: { vue: '^3.5.0', 'example-ui': '^1.0.0' }
    })
    await writeJson(join(vueRoot, 'package.json'), { name: 'vue', version: '3.5.39' })
    await writeJson(join(libraryRoot, 'package.json'), {
      name: 'example-ui',
      version: '1.0.0',
      types: './index.d.ts'
    })
    await writeFile(join(libraryRoot, 'index.d.ts'), "export { ExampleButton } from './button'\n")
    const declaration = join(libraryRoot, 'button.d.ts')
    await writeFile(declaration, 'export declare const ExampleButton: { new(): { $props: { required: string } } }\n')
    await writeFile(join(root, 'src/App.vue'), `<script setup lang="ts">
import { ExampleButton } from 'example-ui'
</script><template><ExampleButton ghost /></template>`)
    const session = createDoctorAnalysisSession({ root, config: { gitAttribution: false } })

    const before = await session.run()
    expect(before.diagnostics.some((item) => item.code === 'component-prop-required-missing')).toBe(true)
    await writeFile(declaration, `export declare const ExampleButton: {
  new(): { $props: { required?: string } }
}\n`)
    session.invalidate(declaration)
    const after = await session.run()

    expect(after.diagnostics.some((item) => item.code === 'component-prop-required-missing')).toBe(false)
    await session.close()
  })

  test('discovers versioned external documents from a nested consuming package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-session-external-'))
    const nested = join(root, 'packages/modern')
    const vueRoot = join(nested, 'node_modules/vue')
    const cssFile = join(nested, 'style.css')
    await mkdir(vueRoot, { recursive: true })
    await writeJson(join(root, 'package.json'), { private: true })
    await writeJson(join(nested, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await writeJson(join(vueRoot, 'package.json'), { name: 'vue', version: '3.5.39' })
    await writeFile(cssFile, '.modern {}')
    let received: string[] = []
    const pack: DoctorRulePack = {
      name: 'modern-css',
      sourceExtensions: ['.css'],
      rules: [{
        code: 'modern-css/check',
        title: 'Modern CSS',
        description: 'Checks Vue 3 CSS.',
        applicability: { vue: { only: 3, minimumMinor: 5 } }
      }],
      run(context) {
        received = context.documents?.map((document) => document.file) ?? []
        return {
          diagnostics: [],
          skippedChecks: [],
          checks: [{ ruleCode: 'modern-css/check', status: 'checked' }]
        }
      }
    }

    const result = await runDoctor({
      root,
      files: [cssFile],
      config: { gitAttribution: false, rulePacks: [pack] }
    })

    expect(received).toEqual([cssFile])
    expect(result.run?.target.files).toEqual(['packages/modern/style.css'])
    expect(result.rulePacks?.[0]?.checks?.find((check) => check.ruleCode === 'modern-css/check')?.status)
      .toBe('checked')
  })

  test('does not derive source profiles for a pack whose rules are all disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-session-disabled-profile-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    await writeFile(join(root, 'src/App.vue'), '<template><button /></template>')
    const disabledPack: DoctorRulePack = {
      name: 'disabled-profile',
      sourceAnalysisProfiles: [{ includeNativeElements: true, resolveConstants: true }],
      rules: [{
        code: 'disabled-profile/check',
        title: 'Disabled profile',
        description: 'Must not derive enriched source facts while disabled.'
      }],
      run() {
        throw new Error('The disabled pack must not execute.')
      }
    }
    let observedFactCount = -1
    const observerPack: DoctorRulePack = {
      name: 'profile-observer',
      rules: [{
        code: 'profile-observer/check',
        title: 'Profile observer',
        description: 'Observes source facts produced for active packs.'
      }],
      run(context) {
        observedFactCount = context.sourceFacts?.length ?? 0
        return {
          diagnostics: [],
          skippedChecks: [],
          checks: [{ ruleCode: 'profile-observer/check', status: 'checked' }]
        }
      }
    }

    await runDoctor({
      root,
      scope: 'src',
      config: {
        gitAttribution: false,
        rules: { 'disabled-profile/check': 'off' },
        rulePacks: [disabledPack, observerPack]
      }
    })

    expect(observedFactCount).toBe(0)
  })
})
