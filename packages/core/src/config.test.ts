import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  applyDoctorConfigToDiagnostics,
  loadDoctorConfig,
  mergeDoctorConfig,
  shouldFailDoctorRun
} from './config.js'
import type { Diagnostic } from './types.js'

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'vue-security-restrict-v-html',
    severity: 'error',
    message: 'v-html is unsafe',
    file: 'src/App.vue',
    evidence: [],
    fixes: [],
    confidence: 'high',
    ...overrides
  }
}

describe('doctor config', () => {
  test('reports the synchronous module boundary for top-level await', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-config-await-'))
    await writeFile(join(root, 'doctor.config.mjs'), 'await Promise.resolve(); export default { failOn: "warning" }')
    await expect(loadDoctorConfig({ root })).rejects.toThrow('do not support top-level await')
  })
  test('validates inline configuration using the same contract as file configuration', () => {
    expect(() => mergeDoctorConfig({ rules: { 'example/rule': 'fatal' } } as never)).toThrow('error|warning|info|off')
    expect(() => mergeDoctorConfig({ scope: 42 } as never)).toThrow('non-empty string')
    expect(() => mergeDoctorConfig({ ui: { autoDetect: 'yes' } } as never)).toThrow('boolean')
    expect(() => mergeDoctorConfig({ eslint: { mode: 'legacy' } } as never)).toThrow('auto|project|builtin|off')
    expect(() => mergeDoctorConfig({ eslint: { mode: 'off', configFile: 'eslint.config.js' } })).toThrow('cannot be used')
  })
  test('loads json config and applies rule severity policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-config-'))
    await writeFile(join(root, 'doctor.config.json'), JSON.stringify({
      scope: 'src',
      rules: {
        'vue-security-restrict-v-html': 'warning',
        'component-prop-unsupported': 'off'
      },
      failOn: 'error',
      failOnIncompleteCoverage: true,
      gitAttribution: false,
      ui: {
        autoDetect: false,
        runtimeContracts: false,
        libraries: [
          'element-plus',
          { package: '@acme/ui', aliases: ['@ui', '@ui'] }
        ]
      },
      eslint: { mode: 'project', configFile: 'eslint.config.mjs' }
    }))

    const loaded = await loadDoctorConfig({ root })
    expect(loaded.path).toContain('doctor.config.json')
    expect(loaded.config.scope).toBe('src')
    expect(loaded.config.gitAttribution).toBe(false)
    expect(loaded.config.ui).toEqual({
      autoDetect: false,
      runtimeContracts: false,
      libraries: [
        'element-plus',
        { package: '@acme/ui', aliases: ['@ui'] }
      ]
    })
    expect(loaded.config.eslint).toEqual({ mode: 'project', configFile: 'eslint.config.mjs' })

    const diagnostics = applyDoctorConfigToDiagnostics([
      diagnostic(),
      diagnostic({ code: 'component-prop-unsupported', severity: 'warning' }),
      diagnostic({ code: 'vue-template-v-for-key', severity: 'warning' })
    ], loaded.config)

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'vue-security-restrict-v-html', severity: 'warning' }),
      expect.objectContaining({ code: 'vue-template-v-for-key', severity: 'warning' })
    ])
  })

  test('loads TypeScript config and its local TypeScript imports through jiti', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-config-ts-'))
    await writeFile(join(root, 'scope.ts'), `export const scope: string = 'src/features'\n`)
    await writeFile(join(root, 'vue-doctor.config.ts'), `
import { scope } from './scope.ts'

const config: { scope: string; ui: { autoDetect: boolean } } = {
  scope,
  ui: { autoDetect: false }
}

export default config
`)

    const loaded = await loadDoctorConfig({ root })

    expect(loaded.path).toBe(join(root, 'vue-doctor.config.ts'))
    expect(loaded.config).toEqual({
      scope: 'src/features',
      ui: { autoDetect: false }
    })
  })

  test('rejects non-boolean Git attribution config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-config-git-'))
    await writeFile(join(root, 'doctor.config.json'), JSON.stringify({
      gitAttribution: 'always'
    }))

    await expect(loadDoctorConfig({ root })).rejects.toThrow(
      'Doctor config "gitAttribution" must be a boolean.'
    )
  })

  test('merges inline config over file config', () => {
    const merged = mergeDoctorConfig(
      {
        scope: 'src',
        rules: { a: 'error' },
        failOn: 'warning',
        gitAttribution: true,
        ui: { autoDetect: true, runtimeContracts: true, libraries: ['element-plus'] },
        eslint: { mode: 'auto' }
      },
      {
        rules: { a: 'off', b: 'info' },
        failOn: 'error',
        gitAttribution: false,
        ui: { autoDetect: false, runtimeContracts: false, libraries: [{ package: '@acme/ui', aliases: ['@ui'] }] },
        eslint: { mode: 'builtin' }
      }
    )
    expect(merged).toEqual({
      scope: 'src',
      rules: { a: 'off', b: 'info' },
      failOn: 'error',
      gitAttribution: false,
      ui: {
        autoDetect: false,
        runtimeContracts: false,
        libraries: [{ package: '@acme/ui', aliases: ['@ui'] }]
      },
      eslint: { mode: 'builtin' }
    })
  })

  test('fails only when threshold is configured', () => {
    const diagnostics = [diagnostic({ severity: 'warning' })]
    expect(shouldFailDoctorRun({
      diagnostics,
      coverageStatus: 'complete'
    })).toBe(false)

    expect(shouldFailDoctorRun({
      diagnostics,
      coverageStatus: 'complete',
      config: { failOn: 'warning' }
    })).toBe(true)

    expect(shouldFailDoctorRun({
      diagnostics: [],
      coverageStatus: 'partial',
      config: { failOnIncompleteCoverage: true }
    })).toBe(true)
  })
})
