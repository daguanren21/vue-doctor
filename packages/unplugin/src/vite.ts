import { Server } from 'node:http'
import type { Plugin, ResolvedConfig } from 'vite'
import { createInspectorBackend, createInspectorHost, type InspectorBackend, type InspectorHost } from '@vue-doctor/inspector/host'
import { createInspectorHubUi, inspectorClientAssets, readInspectorAsset } from '@vue-doctor/inspector-ui/assets'
import { disposeVueDoctorDevframeMount } from '@vue-doctor/inspector/devframe'
import type { runDoctor } from '@vue-doctor/runner'
import type { ComponentLibraryCoverage, Diagnostic, DoctorConfig, DoctorReport, DoctorRunOptions } from '@vue-doctor/core'
import { createHostDoctorSession, type HostDoctorAnalysisSession } from './session.js'

export const inspectorBasePath = '/vue-doctor/'
export const inspectorReportPath = '/vue-doctor/api/report.json'
export const inspectorOpenPath = '/vue-doctor/api/open'
export const inspectorSnippetPath = '/vue-doctor/api/snippet'
export type VueDoctorRunMode = 'serve' | 'build' | 'both'
export interface VueDoctorViteOptions {
  run?: VueDoctorRunMode
  mode?: 'warn'
  inspector?: boolean
  scope?: DoctorRunOptions['scope']
  config?: DoctorConfig
}
export interface VueDoctorViteServices {
  runDoctor: typeof runDoctor
  createAnalysisSession?: (options: DoctorRunOptions) => HostDoctorAnalysisSession
}
interface DoctorDevtoolsContext {
  install(definition: InspectorBackend['definition'], options?: {
    dock?: { frameId: string; subTabs: { protocol: 'postmessage' } }
  }): Promise<unknown>
}
export type VueDoctorVitePlugin = Plugin & {
  devtools: { setup(context: DoctorDevtoolsContext): Promise<void> }
}

export function createVueDoctorPlugin(options: VueDoctorViteOptions, services: VueDoctorViteServices): VueDoctorVitePlugin {
  const run = options.run ?? 'serve'
  const inspector = options.inspector ?? true
  let config: ResolvedConfig | undefined
  let session: HostDoctorAnalysisSession | undefined
  let backendPromise: Promise<InspectorBackend> | undefined
  let resolvedBackend: InspectorBackend | undefined
  let fallbackHost: InspectorHost | undefined
  let fallbackPromise: Promise<InspectorHost> | undefined
  let nativeHost = false
  let initialReport: Promise<DoctorReport> | undefined
  let initialWarningsReported = false
  let detachWatcher: (() => void) | undefined
  let closing: Promise<void> | undefined
  let closed = false
  let nativeMount: { backend: InspectorBackend; context: Parameters<InspectorBackend['definition']['setup']>[0] } | undefined
  const getSession = (root = config?.root ?? process.cwd()) => session ??= createHostDoctorSession(services, {
    root, scope: options.scope, ...(options.config ? { config: options.config } : {})
  })
  const getInitialReport = (root?: string) => {
    if (!initialReport) {
      const pending = getSession(root).run()
      initialReport = pending
      void pending.catch(() => { if (initialReport === pending) initialReport = undefined })
    }
    return initialReport
  }
  const getBackend = (root?: string) => {
    if (closed) return Promise.reject(new Error('Doctor Inspector host is closed.'))
    if (!backendPromise) {
      const pending = (async () => {
        const report = await getInitialReport(root)
        if (closed) throw new Error('Doctor Inspector host is closed.')
        resolvedBackend = createInspectorBackend({
          report,
          getReport: () => getSession(root).run(),
          run: () => {
            const current = getSession(root)
            current.invalidate()
            return current.run()
          },
          clientAssets: inspectorClientAssets,
          readClientAsset: readInspectorAsset
        })
        return resolvedBackend
      })()
      backendPromise = pending
      void pending.catch(() => { if (backendPromise === pending) backendPromise = undefined })
    }
    return backendPromise
  }
  const close = () => closing ??= (async () => {
    closed = true
    if (nativeMount) disposeVueDoctorDevframeMount(nativeMount.backend.definition, nativeMount.context)
    detachWatcher?.()
    detachWatcher = undefined
    try {
      if (fallbackPromise) await fallbackPromise.then((host) => host.close(), () => {})
      if (backendPromise) await backendPromise.then((backend) => backend.close(), () => {})
    } finally { await session?.close() }
  })()

  return {
    name: 'vue-doctor', enforce: 'pre',
    apply: run === 'both' ? undefined : run,
    configResolved(resolvedConfig) { config = resolvedConfig },
    devtools: {
      async setup(context) {
        if (!inspector) return
        const backend = await getBackend()
        if (closed) throw new Error('Doctor Inspector host is closed.')
        const definition: InspectorBackend['definition'] = {
          ...backend.definition,
          async setup(mountContext) {
            if (closed) throw new Error('Doctor Inspector host is closed.')
            nativeMount = { backend, context: mountContext }
            await backend.definition.setup(mountContext)
            if (closed) {
              disposeVueDoctorDevframeMount(backend.definition, mountContext)
              throw new Error('Doctor Inspector host is closed.')
            }
          }
        }
        try {
          await context.install(definition, {
            dock: { frameId: 'vue-doctor', subTabs: { protocol: 'postmessage' } }
          })
        } catch (error) {
          if (nativeMount) disposeVueDoctorDevframeMount(backend.definition, nativeMount.context)
          throw error
        }
        if (closed) throw new Error('Doctor Inspector host is closed.')
        nativeHost = true
        // A late native host takes ownership of presentation, using the same backend.
        if (fallbackPromise) await fallbackPromise.then((host) => host.closeTransport(), () => {})
      }
    },
    async buildStart() {
      await runDoctorAndWarn({
        runDoctor: () => {
          if (!inspector || initialWarningsReported) return getSession().run()
          initialWarningsReported = true
          return getInitialReport()
        }
      }, { root: config?.root ?? process.cwd(), scope: options.scope }, (message) => this.warn(message))
    },
    configureServer(server) {
      const invalidate = (_event: string, path: string) => getSession(server.config.root).invalidate(path)
      server.watcher?.on('all', invalidate)
      const onClose = () => { void close() }
      server.httpServer?.once('close', onClose)
      detachWatcher = () => {
        server.watcher?.off('all', invalidate)
        server.httpServer?.off('close', onClose)
      }
      if (!inspector) return
      server.middlewares.use((request, response, next) => {
        if (closed) next()
        else if (nativeHost && resolvedBackend) resolvedBackend.compatibilityMiddleware(request, response, next)
        else if (fallbackHost) fallbackHost.nodeMiddleware(request, response, next)
        else next()
      })
      // Post hook gives an installed DevTools host first opportunity to claim the frame.
      return async () => {
        try {
          const backend = await getBackend(config?.root ?? server.config.root)
          if (nativeHost) {
            return
          }
          fallbackPromise = createInspectorHost({
            report: backend.store.getReport(backend.store.getSnapshot().snapshotId),
            backend,
            server: server.httpServer instanceof Server ? server.httpServer : undefined,
            hubUi: createInspectorHubUi(inspectorBasePath)
          })
          fallbackHost = await fallbackPromise
          if (closed) { await fallbackHost.close(); return }
          if (nativeHost) await fallbackHost.closeTransport()
        } catch (error) {
          server.config.logger.warn(`[vue-doctor] Inspector initialization failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    watchChange(id) { session?.invalidate(id) },
    closeBundle: close
  }
}

export async function runDoctorAndWarn(
  services: VueDoctorViteServices,
  options: DoctorRunOptions,
  warn: (message: string) => void
): Promise<void> {
  try {
    const report = await services.runDoctor(options)
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.severity !== 'info') {
        warn(formatDiagnosticWarning(report, diagnostic))
      }
    }

    const coverageWarning = formatCoverageWarning(report)
    if (coverageWarning) {
      warn(coverageWarning)
    }
  } catch (error) {
    warn(`[vue-doctor] Doctor Run failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function formatCoverageWarning(report: DoctorReport): string | undefined {
  if (report.coverage.status === 'complete') {
    return undefined
  }

  const affected = report.coverage.componentLibraries.filter((library) => library.status !== 'complete')
  const sourceNeedsAttention = report.coverage.source.status !== 'complete'
  const subjects: string[] = []
  if (affected.length > 0) {
    subjects.push(`${affected.length} component ${affected.length === 1 ? 'library needs' : 'libraries need'} attention`)
  }
  if (sourceNeedsAttention) {
    subjects.push(report.coverage.source.status === 'blocked'
      ? 'source scanning is unavailable'
      : 'source scan needs attention')
  }

  const summary = `[vue-doctor] COVERAGE ${report.coverage.status}: ${subjects.join('; ') || 'analysis coverage needs attention'}`
  const details = [
    ...affected.map(formatLibraryCoverage),
    ...(sourceNeedsAttention ? [formatSourceCoverage(report)] : [])
  ].join('\n')

  return details ? `${summary}\n${details}` : summary
}

function formatLibraryCoverage(library: ComponentLibraryCoverage): string {
  const problemCodes = [...new Set(library.problems.map((problem) => problem.code))]
  const problems = problemCodes.length > 0 ? ` - ${problemCodes.join(', ')}` : ''

  return `  ${library.package.canonicalName}: ${library.status}${problems}`
}

function formatSourceCoverage(report: DoctorReport): string {
  const source = report.coverage.source
  if (source.status === 'blocked') {
    return '  source: blocked - scanning did not run'
  }

  const failedFileCount = source.failedFiles.length
  const summary = `  source: ${source.status} - ${failedFileCount} ${failedFileCount === 1 ? 'file' : 'files'} failed to scan`
  const files = source.failedFiles.map((failure) => `    ${failure.file}: ${failure.message}`).join('\n')

  return files ? `${summary}\n${files}` : summary
}

function formatDiagnosticWarning(report: DoctorReport, diagnostic: Diagnostic): string {
  const primary = diagnostic.primaryLocation
  const file = primary?.file ?? diagnostic.file
  const point = primary?.start
  const position = point ? `:${point.line}${point.column === undefined ? '' : `:${point.column}`}` : ''
  const location = file ? `\n  at ${file}${position}` : ''
  const version = formatProjectVersions(report)

  return `[vue-doctor] ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${location}${version}`
}

function formatProjectVersions(report: DoctorReport): string {
  const versions = [
    report.project.vueVersion ? `vue ${report.project.vueVersion}` : undefined,
    report.project.viteVersion ? `vite ${report.project.viteVersion}` : undefined
  ].filter(Boolean)

  return versions.length > 0 ? `\n  project: ${versions.join(', ')}` : ''
}
