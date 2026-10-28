import { createDoctorAnalysisSession, runDoctor } from '@daguanren21/vue-doctor-runner'
import { createUnplugin } from 'unplugin'
import { createVueDoctorUnpluginFactory } from './plugin.js'

export const vueDoctorUnplugin = createUnplugin(
  createVueDoctorUnpluginFactory({ runDoctor, createAnalysisSession: createDoctorAnalysisSession })
)

export const vueDoctorVite = vueDoctorUnplugin.vite
export const vueDoctorWebpack = vueDoctorUnplugin.webpack
export const vueDoctorRspack = vueDoctorUnplugin.rspack
export const vueDoctorRollup = vueDoctorUnplugin.rollup
export const vueDoctorRolldown = vueDoctorUnplugin.rolldown
export const vueDoctorEsbuild = vueDoctorUnplugin.esbuild

export { createVueDoctorUnpluginFactory } from './plugin.js'
export type { VueDoctorRunMode, VueDoctorUnpluginOptions, VueDoctorViteOptions } from './options.js'
export {
  createVueDoctorPlugin,
  inspectorBasePath,
  inspectorOpenPath,
  inspectorReportPath,
  inspectorSnippetPath
} from './vite.js'
export type { VueDoctorViteServices } from './vite.js'
