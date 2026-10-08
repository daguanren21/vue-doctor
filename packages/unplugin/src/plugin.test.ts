import type { DoctorReport } from '@vue-doctor/core'
import type {
  UnpluginBuildContext,
  UnpluginContextMeta,
  UnpluginOptions
} from 'unplugin'
import { describe, expect, test } from 'vitest'
import { createVueDoctorUnpluginFactory } from './plugin.js'

function createReport(root: string): DoctorReport {
  return {
    project: {
      root,
      vueVersion: '3.5.39',
      vueFramework: 'vue3',
      uiLibraries: []
    },
    inventory: { root, packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 1, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics: [{
      code: 'component-event-unsupported',
      severity: 'warning',
      message: 'ExampleButton does not declare event "missing".',
      evidence: [],
      fixes: [],
      confidence: 'high'
    }]
  }
}

async function invokeBuildStart(
  plugin: UnpluginOptions,
  framework: 'webpack' | 'rspack' = 'webpack'
) {
  const warnings: Error[] = []
  if (typeof plugin.buildStart !== 'function') {
    throw new Error('Expected buildStart hook.')
  }
  await plugin.buildStart.call({
    getNativeBuildContext() {
      return {
        framework,
        compilation: { warnings }
      }
    }
  } as unknown as UnpluginBuildContext)
  return warnings.map((warning) => warning.message)
}

describe('Vue Doctor unplugin', () => {
  test('uses webpack compiler context and forwards inline Doctor config', async () => {
    const calls: unknown[] = []
    const factory = createVueDoctorUnpluginFactory({
      async runDoctor(options) {
        calls.push(options)
        return createReport(options?.root ?? '')
      }
    })
    const meta = {
      framework: 'webpack',
      webpack: {
        compiler: {
          context: '/workspace/webpack-app',
          options: { mode: 'production' }
        }
      },
      versions: { unplugin: '3.3.0', webpack: '5.101.3' }
    } as unknown as UnpluginContextMeta
    const plugin = factory({
      run: 'build',
      scope: 'src/features',
      config: { ui: { libraries: ['element-plus'] } }
    }, meta)

    const warnings = await invokeBuildStart(plugin)

    expect(calls).toEqual([{
      root: '/workspace/webpack-app',
      scope: 'src/features',
      config: { ui: { libraries: ['element-plus'] } }
    }])
    expect(warnings).toEqual([
      expect.stringContaining('component-event-unsupported')
    ])
  })

  test('uses rspack development mode for the default serve run', async () => {
    const roots: Array<string | undefined> = []
    const factory = createVueDoctorUnpluginFactory({
      async runDoctor(options) {
        roots.push(options?.root)
        return createReport(options?.root ?? '')
      }
    })
    const meta = {
      framework: 'rspack',
      rspack: {
        compiler: {
          context: '/workspace/rspack-app',
          options: { mode: 'development' }
        }
      },
      versions: { unplugin: '3.3.0', rspack: '1.5.8' }
    } as unknown as UnpluginContextMeta

    await invokeBuildStart(factory(undefined, meta), 'rspack')

    expect(roots).toEqual(['/workspace/rspack-app'])
  })

  test('does not run serve-only diagnostics in production builds', async () => {
    let runCount = 0
    const factory = createVueDoctorUnpluginFactory({
      async runDoctor() {
        runCount += 1
        return createReport('/workspace/webpack-app')
      }
    })
    const meta = {
      framework: 'webpack',
      webpack: {
        compiler: {
          context: '/workspace/webpack-app',
          options: { mode: 'production' }
        }
      },
      versions: { unplugin: '3.3.0', webpack: '5.101.3' }
    } as unknown as UnpluginContextMeta

    expect(await invokeBuildStart(factory(undefined, meta))).toEqual([])
    expect(runCount).toBe(0)
  })

  test('runs build-only hosts with default options', async () => {
    const frameworks = ['rollup', 'rolldown', 'esbuild'] as const
    const calls: string[] = []
    const factory = createVueDoctorUnpluginFactory({
      async runDoctor() {
        calls.push('run')
        return {
          ...createReport('/workspace/build-app'),
          diagnostics: []
        }
      }
    })

    for (const framework of frameworks) {
      const plugin = factory(undefined, {
        framework,
        versions: { unplugin: '3.3.0', [framework]: '1.0.0' }
      } as UnpluginContextMeta)
      await invokeBuildStart(plugin)
    }

    expect(calls).toEqual(['run', 'run', 'run'])
  })

  test('keeps the Vite Inspector surface on the unplugin Vite adapter', () => {
    const factory = createVueDoctorUnpluginFactory({
      async runDoctor(options) {
        return createReport(options?.root ?? '')
      }
    })
    const plugin = factory(undefined, {
      framework: 'vite',
      versions: { unplugin: '3.3.0', vite: '8.1.3' }
    })
    const vite = plugin.vite as { apply?: unknown; configureServer?: unknown }

    expect(vite.apply).toBe('serve')
    expect(vite.configureServer).toBeTypeOf('function')
  })
})
