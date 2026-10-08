import type { DoctorRunOptions } from '@vue-doctor/core'
import type {
  NativeBuildContext,
  UnpluginBuildContext,
  UnpluginContextMeta,
  UnpluginFactory
} from 'unplugin'
import {
  createVueDoctorPlugin,
  runDoctorAndWarn,
  type VueDoctorViteOptions,
  type VueDoctorViteServices
} from './vite.js'
import { createHostDoctorSession, type HostDoctorAnalysisSession } from './session.js'

export type VueDoctorUnpluginOptions = VueDoctorViteOptions

export function createVueDoctorUnpluginFactory(
  services: VueDoctorViteServices
): UnpluginFactory<VueDoctorUnpluginOptions | undefined, false> {
  return (options = {}, meta) => {
    if (meta.framework === 'vite') {
      return {
        name: 'vue-doctor',
        enforce: 'pre',
        vite: createVueDoctorPlugin(options, services)
      }
    }

    let session: HostDoctorAnalysisSession | undefined
    return {
      name: 'vue-doctor',
      enforce: 'pre',
      async buildStart() {
        if (!shouldRunForHost(options.run ?? 'serve', meta)) {
          return
        }
        const doctorOptions: DoctorRunOptions = {
          root: resolveHostRoot(meta),
          scope: options.scope,
          ...(options.config ? { config: options.config } : {})
        }
        session ??= createHostDoctorSession(services, doctorOptions)
        await runDoctorAndWarn({ runDoctor: () => session!.run() }, doctorOptions, (message) => {
          emitBuildWarning(this, message)
        })
      },
      watchChange(id) {
        session?.invalidate(id)
      },
      async closeBundle() {
        await session?.close()
      }
    }
  }
}

function emitBuildWarning(context: UnpluginBuildContext, message: string): void {
  const nativeContext: NativeBuildContext | undefined = context.getNativeBuildContext?.()
  if (
    nativeContext
    && (nativeContext.framework === 'webpack' || nativeContext.framework === 'rspack')
    && nativeContext.compilation
  ) {
    nativeContext.compilation.warnings.push(new Error(message))
    return
  }
  console.warn(message)
}

function shouldRunForHost(
  run: NonNullable<VueDoctorUnpluginOptions['run']>,
  meta: UnpluginContextMeta
): boolean {
  if (run === 'both') {
    return true
  }
  if (meta.framework !== 'webpack' && meta.framework !== 'rspack') {
    return true
  }

  const hostMode = meta.framework === 'webpack'
    ? meta.webpack.compiler.options.mode
    : meta.rspack.compiler.options.mode
  const command = hostMode === 'development' ? 'serve' : 'build'
  return run === command
}

function resolveHostRoot(meta: UnpluginContextMeta): string {
  if (meta.framework === 'webpack') {
    return meta.webpack.compiler.context
  }
  if (meta.framework === 'rspack') {
    return meta.rspack.compiler.context
  }
  return process.cwd()
}
