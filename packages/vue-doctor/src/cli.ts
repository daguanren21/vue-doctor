#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { realpathSync, watch, type FSWatcher } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { cac } from 'cac'
import packageJson from '../package.json' with { type: 'json' }
import type { Diagnostic, DoctorConfig, DoctorReport, DoctorRuleDefinition, DoctorRunOptions, EvidenceLocation } from '@vue-doctor/core'
import { shouldFailDoctorRun } from '@vue-doctor/core'
import type { InspectorReportStore } from '@vue-doctor/inspector/store'
import type { startVueDoctorMcpServer } from '@vue-doctor/inspector/mcp'
import type { DiagnosticReference } from '@vue-doctor/diagnostic-reference'
import { createDoctorAnalysisSession, resolveDoctorRuleCatalogs, runDoctor, summarizeDoctorReport } from '@vue-doctor/runner'
import { startInspectorServer } from './inspect.js'
import { resolveChangedFiles } from './changed-files.js'
import { installGithubActionsWorkflow } from './ci.js'
import {
  detectAvailableSkillAgents,
  installVueDoctorSkill,
  listSupportedSkillAgents
} from './install-skill.js'

export interface CliIO {
  cwd: string
  isTTY?: boolean
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export interface CliServices {
  runDoctor: typeof runDoctor
  startInspector: typeof startInspectorServer
  createAnalysisSession?: (options: DoctorRunOptions) => {
    run(): Promise<DoctorReport>
    invalidate(pathOrPaths?: string | readonly string[]): void
    close(): Promise<void>
  }
  startMcp?: typeof startVueDoctorMcpServer
  waitForMcpShutdown?: () => Promise<void>
}

const startMcpServer: typeof startVueDoctorMcpServer = async options => (await import('@vue-doctor/inspector/mcp')).startVueDoctorMcpServer(options)

const defaultServices: CliServices = { runDoctor, startInspector: startInspectorServer,
  createAnalysisSession: createDoctorAnalysisSession,
  startMcp: startMcpServer }

type CliOptions = {
  json?: boolean
  verbose?: boolean
  version?: boolean
  jsonOut?: string
  inspect?: boolean
  scope?: string
  config?: string
  failOn?: 'error' | 'warning' | 'info' | 'never'
  failOnIncompleteCoverage?: boolean
  changed?: boolean
  changedBase?: string
  force?: boolean
  agent?: string | string[]
  allAgents?: boolean
  global?: boolean
}

type CliRuleReference = DiagnosticReference & Pick<
  DoctorRuleDefinition,
  'verification' | 'category' | 'standards' | 'domain' | 'tags'
>

export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: CliIO = defaultIO(),
  services: CliServices = defaultServices
): Promise<number> {
  let ownedInspectSession: ReturnType<NonNullable<CliServices['createAnalysisSession']>> | undefined
  let inspectorOwnsSession = false
  let inspectorWatcher: FSWatcher | undefined
  let watcherClosed = false
  const cli = cac('vue-doctor')
  cli.version(packageJson.version)
  cli.usage('[root] [options]')
  cli.outputVersion = () => io.stdout(`vue-doctor/${packageJson.version}\n`)
  cli.option('--json', 'Print a structured Doctor report')
  cli.option('--json-out <file>', 'Write a structured Doctor report to a file')
  cli.option('--verbose', 'Show every diagnostic with full evidence and fix suggestions')
  cli.option('--scope <path>', 'Limit diagnostics to a project subpath')
  cli.option('--config <file>', 'Load an explicit Doctor config file')
  cli.option('--fail-on <level>', 'Fail when diagnostics reach this severity (error|warning|info|never)')
  cli.option('--fail-on-incomplete-coverage', 'Fail when coverage is partial or blocked')
  cli.option('--changed', 'Limit diagnostics to git-changed files')
  cli.option('--changed-base <ref>', 'Git base for --changed (auto|HEAD|<ref>)')
  cli.option('--force', 'Overwrite existing files for install commands')
  cli.option('--agent <name>', 'Target coding agent for skill install (repeatable)')
  cli.option('--all-agents', 'Install the skill for every detected coding agent')
  cli.option('--global', 'Prefer user-global skill install locations when supported')
  cli.option('--inspect', 'Open the live Doctor Inspector and keep this process running')
  cli.example('vue-doctor')
  cli.example('vue-doctor ../my-vue-app --scope src')
  cli.example('vue-doctor --inspect')
  cli.example('vue-doctor --verbose')
  cli.example('vue-doctor --json-out doctor-report.json')
  cli.example('vue-doctor rules')
  cli.example('vue-doctor install')
  cli.example('vue-doctor ci install')
  cli.example('vue-doctor mcp . --scope src')
  cli.help()

  try {
    // Support `vue-doctor --help` / `-h` without running a Doctor scan.
    if (argv.includes('--help') || argv.includes('-h')) {
      cli.parse(['node', 'vue-doctor', '--help'], { run: false })
      return 0
    }

    const parsed = cli.parse(['node', 'vue-doctor', ...argv], { run: false })
    const options = parsed.options as CliOptions
    if (options.version) return 0

    if (parsed.args[0] === 'rules') {
      return await runRulesCommand(parsed.args.slice(1).map(String), io, options)
    }

    if (parsed.args[0] === 'ci') {
      return runCiCommand(parsed.args.slice(1).map(String), options, io)
    }

    if (parsed.args[0] === 'install') {
      return runInstallCommand(parsed.args.slice(1).map(String), options, io)
    }

    if (parsed.args[0] === 'mcp') {
      return await runMcpCommand(parsed.args.slice(1).map(String), options, io, services)
    }

    const root = resolve(io.cwd, String(parsed.args[0] ?? '.'))
    let files: readonly string[] | undefined
    if (options.changed) {
      try {
        const changed = resolveChangedFiles({
          root,
          base: (options.changedBase as 'auto' | 'HEAD' | string | undefined) ?? 'auto'
        })
        files = changed.files
        if (!options.json) {
          io.stdout(`Changed scope: ${changed.files.length} files (base: ${changed.base})\n`)
        }
      } catch (error) {
        io.stderr(`Failed to resolve changed files: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }

    const cliConfig: DoctorConfig = {
      ...(options.failOn ? { failOn: options.failOn } : {}),
      ...(options.failOnIncompleteCoverage ? { failOnIncompleteCoverage: true } : {})
    }
    let gateConfig: DoctorConfig = cliConfig

    const doctorOptions: DoctorRunOptions = {
      root,
      scope: options.scope,
      ...(files ? { files } : {}),
      configFile: options.config,
      config: cliConfig,
      onConfigResolved(config) {
        gateConfig = config
      }
    }
    const scanStarted = performance.now()
    if (io.isTTY && !options.json) io.stderr(`Scanning ${root}${options.scope ? ` (${options.scope})` : ''}...\n`)
    if (options.inspect && services.createAnalysisSession) {
      ownedInspectSession = services.createAnalysisSession(doctorOptions)
    }
    const report = ownedInspectSession ? await ownedInspectSession.run() : await services.runDoctor(doctorOptions)
    if (io.isTTY && !options.json) io.stderr(`Scan finished in ${((performance.now() - scanStarted) / 1000).toFixed(1)}s.\n`)

    if (options.jsonOut) {
      const outputFile = resolve(io.cwd, options.jsonOut)
      await mkdir(dirname(outputFile), { recursive: true })
      await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      if (io.isTTY && !options.json) io.stderr(`Report written: ${outputFile}\n`)
    }

    if (options.json || !options.jsonOut) {
      io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report, { verbose: options.verbose }))
    }

    if (options.inspect) {
      const session = ownedInspectSession
      if (session) {
        try {
          inspectorWatcher = watch(root, { recursive: true }, (_event, filename) => {
            if (!watcherClosed) session.invalidate(filename ? resolve(root, filename.toString()) : undefined)
          })
          inspectorWatcher.on('error', (error) => {
            inspectorWatcher?.close()
            io.stderr(`Inspector file watching unavailable: ${error.message}\n`)
          })
        } catch (error) {
          io.stderr(`Inspector file watching unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      const inspector = await services.startInspector({ report, open: true,
        ...(session ? { getReport: () => session.run(), run: () => {
          session.invalidate()
          return session.run()
        }, onClose: async () => {
          watcherClosed = true
          inspectorWatcher?.close()
          await session.close()
        } } : {})
      })
      inspectorOwnsSession = true
      const inspectorMessage = `Inspector: ${inspector.url}\n`
      if (options.json) io.stderr(inspectorMessage)
      else io.stdout(inspectorMessage)
    }

    const summary = summarizeDoctorReport(report)
    const failed = shouldFailDoctorRun({
      diagnostics: report.diagnostics,
      coverageStatus: report.coverage.status,
      config: gateConfig
    })
    const gateEnabled = (
      (gateConfig.failOn !== undefined && gateConfig.failOn !== 'never')
      || gateConfig.failOnIncompleteCoverage === true
    )
    if (!options.json && !options.jsonOut && gateEnabled) {
      io.stdout(formatGateLine(summary, failed))
    }
    return failed ? 1 : 0
  } catch (error) {
    if (!inspectorOwnsSession) {
      watcherClosed = true
      inspectorWatcher?.close()
      await ownedInspectSession?.close()
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runMcpCommand(
  args: string[],
  options: CliOptions,
  io: CliIO,
  services: CliServices
): Promise<number> {
  const restoreConsole = redirectMcpConsole(io)
  const createSession = services.createAnalysisSession ?? createDoctorAnalysisSession
  const startMcp = services.startMcp ?? startMcpServer
  const shutdownLatch = services.waitForMcpShutdown ? undefined : createMcpShutdownLatch()
  const shutdown = services.waitForMcpShutdown?.() ?? shutdownLatch!.promise
  const root = resolve(io.cwd, String(args[0] ?? '.'))
  let session: ReturnType<typeof createSession> | undefined
  let store: InspectorReportStore | undefined
  let server: Awaited<ReturnType<typeof startVueDoctorMcpServer>> | undefined
  try {
    session = createSession({
      root,
      scope: options.scope,
      configFile: options.config
    })
    const activeSession = session
    const initialReport = await activeSession.run()
    const { InspectorReportStore } = await import('@vue-doctor/inspector/store')
    store = new InspectorReportStore({
      initialReport,
      run: () => {
        activeSession.invalidate()
        return activeSession.run()
      }
    })
    server = await startMcp({ store })
    await shutdown
    return 0
  } finally {
    try {
      try {
        await server?.stop().catch((error) => {
          io.stderr(`Failed to stop Vue Doctor MCP: ${error instanceof Error ? error.message : String(error)}\n`)
        })
      } finally {
        try {
          store?.close()
        } finally {
          await session?.close()
        }
      }
    } finally {
      try {
        shutdownLatch?.dispose()
      } finally {
        restoreConsole()
      }
    }
  }
}

function redirectMcpConsole(io: CliIO): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug
  }
  const toStderr = (...values: unknown[]) => io.stderr(`${format(...values)}\n`)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  return () => {
    console.log = original.log
    console.info = original.info
    console.debug = original.debug
  }
}

function createMcpShutdownLatch(): { promise: Promise<void>; dispose(): void } {
  let finish = () => {}
  const promise = new Promise<void>((resolveShutdown) => {
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      resolveShutdown()
      return
    }
    finish = () => {
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      process.stdin.off('end', finish)
      process.stdin.off('close', finish)
      resolveShutdown()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    process.stdin.once('end', finish)
    process.stdin.once('close', finish)
  })
  return {
    promise,
    dispose() {
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      process.stdin.off('end', finish)
      process.stdin.off('close', finish)
    }
  }
}

async function runInstallCommand(args: string[], options: CliOptions, io: CliIO): Promise<number> {
  const subcommand = args[0] ?? 'skill'
  if (subcommand !== 'skill' && subcommand !== undefined) {
    // allow `vue-doctor install` with no subcommand
  }
  if (args[0] && !['skill', 'agents'].includes(args[0]) && !args[0].startsWith('-')) {
    // `vue-doctor install claude-code` convenience
  }

  if (args[0] === 'agents') {
    const supported = listSupportedSkillAgents()
    const detected = await detectAvailableSkillAgents()
    io.stdout('Supported agents:\n')
    for (const agent of supported) {
      io.stdout(`  - ${agent}${detected.includes(agent) ? ' (detected)' : ''}\n`)
    }
    return 0
  }

  try {
    const requested = normalizeAgentOption(options.agent)
    // Convenience: `vue-doctor install claude-code cursor`
    const positionalAgents = args.filter((arg) => arg !== 'skill' && !arg.startsWith('-'))
    const agents = requested.length > 0 ? requested : positionalAgents

    const result = await installVueDoctorSkill({
      cwd: io.cwd,
      agents,
      allDetected: Boolean(options.allAgents),
      global: Boolean(options.global),
      force: Boolean(options.force)
    })

    if (result.skipped.length > 0) {
      io.stderr(`Skipped unknown agents: ${result.skipped.join(', ')}\n`)
    }

    if (result.agents.length === 0) {
      io.stderr('No coding agents selected.\n')
      io.stderr('Detected none of the default agents (claude-code, cursor, codex, opencode).\n')
      io.stderr('Use `--agent <name>`, `--all-agents`, or `vue-doctor install agents`.\n')
      return 1
    }

    if (result.installed.length === 0 && result.failed.length === 0) {
      io.stdout(`Skill source: ${result.source}\n`)
      io.stdout(`Target agents: ${result.agents.join(', ')}\n`)
      io.stdout('No skill files were installed.\n')
      return 1
    }

    io.stdout(`Skill source: ${result.source}\n`)
    for (const item of result.installed) {
      io.stdout(`Installed for ${item.agent}: ${item.path}\n`)
    }
    for (const item of result.failed) {
      const message = item.error || 'install failed'
      io.stderr(`Failed for ${item.agent}: ${message}\n`)
    }

    io.stdout('Next: ask your coding agent to run Vue Doctor triage after Vue changes.\n')
    return result.failed.length > 0 ? 1 : 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function normalizeAgentOption(value: string | string[] | undefined): string[] {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean)
}

async function runCiCommand(args: string[], options: CliOptions, io: CliIO): Promise<number> {
  const subcommand = args[0] ?? 'install'
  if (subcommand !== 'install') {
    io.stderr(`Unknown ci subcommand: ${subcommand}\n`)
    io.stderr('Usage: vue-doctor ci install [--fail-on error] [--changed]\n')
    return 1
  }

  try {
    const result = await installGithubActionsWorkflow({
      root: io.cwd,
      force: Boolean(options.force),
      failOn: options.failOn ?? 'error',
      failOnIncompleteCoverage: options.failOnIncompleteCoverage ?? true,
      changed: options.changed ?? true
    })
    if (result.status === 'exists') {
      io.stdout(`GitHub Actions workflow already exists: ${result.workflowPath}\n`)
      io.stdout('Re-run with --force to overwrite.\n')
      return 0
    }
    io.stdout(`Created ${result.workflowPath}\n`)
    io.stdout('Commit the workflow, then push to enable Vue Doctor on pull requests.\n')
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runRulesCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
  const catalogs = await resolveDoctorRuleCatalogs({
    root: io.cwd,
    configFile: options.config,
    scope: options.scope
  })
  const references: CliRuleReference[] = catalogs.flatMap((catalog) => catalog.rules.map((rule) => ({
    code: rule.code,
    rulePack: catalog.name,
    title: rule.title,
    problem: rule.help?.problem ?? rule.description,
    remediation: rule.help?.remediation ?? (rule.verification && rule.verification !== 'static'
      ? 'Perform the stated acceptance scenario or resolve its prerequisite. This item has not passed a static check.'
      : 'Apply the configured policy above, or explicitly override this rule in doctor.config.ts.'),
    verification: rule.verification,
    category: rule.category,
    standards: rule.standards,
    domain: rule.domain,
    tags: rule.tags
  })))
  const subcommand = args[0] ?? 'list'

  if (subcommand === 'explain') {
    const code = args[1]
    if (!code) {
      io.stderr('Missing diagnostic code.\n')
      io.stderr('Usage: vue-doctor rules explain <code>\n')
      return 1
    }

    const reference = references.find((rule) => rule.code === code)
    if (!reference) {
      io.stderr(`Unknown diagnostic code: ${code}\n`)
      return 1
    }

    io.stdout(formatDiagnosticReference(reference))
    return 0
  }

  if (subcommand === 'list') {
    io.stdout(formatDiagnosticReferenceList(references, args[1]))
    return 0
  }

  const reference = references.find((rule) => rule.code === subcommand)
  if (reference) {
    io.stdout(formatDiagnosticReference(reference))
    return 0
  }

  io.stderr(`Unknown rules subcommand or diagnostic code: ${subcommand}\n`)
  io.stderr('Usage: vue-doctor rules [list [rule-pack]|explain <code>]\n')
  return 1
}

function formatDiagnosticReferenceList(
  references: CliRuleReference[],
  packFilter?: string
): string {
  const filtered = packFilter
    ? references.filter((reference) => reference.rulePack === packFilter)
    : references
  const lines = ['Vue Doctor Diagnostic Reference', '']
  if (filtered.length === 0) {
    lines.push(packFilter
      ? `No diagnostic codes found for rule pack "${packFilter}".`
      : 'No diagnostic codes registered.')
    return `${lines.join('\n')}\n`
  }

  const packs = new Map<string, CliRuleReference[]>()
  for (const reference of filtered) {
    const list = packs.get(reference.rulePack) ?? []
    list.push(reference)
    packs.set(reference.rulePack, list)
  }

  for (const [pack, items] of [...packs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`[${pack}]`)
    for (const reference of items) {
      lines.push(`  ${reference.code}`)
      lines.push(`    ${reference.title}${reference.verification ? ` [${reference.verification}]` : ''}`)
    }
    lines.push('')
  }

  lines.push('Explain a code:')
  lines.push('  vue-doctor rules explain <code>')
  return `${lines.join('\n').trimEnd()}\n`
}

function formatDiagnosticReference(reference: CliRuleReference): string {
  return [
    `${reference.code}`,
    `${reference.title}`,
    `rule pack: ${reference.rulePack}`,
    ...(reference.verification ? [`verification: ${reference.verification}`] : []),
    ...(reference.category ? [`category: ${reference.category}`] : []),
    ...(reference.domain ? [`domain: ${reference.domain}`] : []),
    ...(reference.tags?.length ? [`tags: ${reference.tags.join(', ')}`] : []),
    ...(reference.standards?.length ? [`standards: ${reference.standards.join(', ')}`] : []),
    '',
    'Problem:',
    reference.problem,
    '',
    'Remediation:',
    reference.remediation
  ].join('\n') + '\n'
}

export function formatSummary(report: DoctorReport, options: { verbose?: boolean } = {}): string {
  const count = report.diagnostics.length
  const lines = [`Vue Doctor checked ${report.project.root}`]
  const versions = [
    report.project.vueVersion ? `Vue ${report.project.vueVersion}` : undefined,
    report.project.viteVersion ? `Vite ${report.project.viteVersion}` : undefined
  ].filter((version): version is string => version !== undefined)
  const severityCounts = { error: 0, warning: 0, info: 0 }
  for (const diagnostic of report.diagnostics) severityCounts[diagnostic.severity]++
  const libraries = getCoverageLibraries(report)
  const affectedLibraries = libraries.filter((library) => library.status !== 'complete')
  const sourceNeedsAttention = report.coverage.source.status !== 'complete'

  lines.push(`Versions: ${versions.length > 0 ? versions.join(', ') : 'none detected'}`)
  lines.push(
    `Diagnostics: ${count} total - ${formatCount(severityCounts.error, 'error')}, `
      + `${formatCount(severityCounts.warning, 'warning')}, ${severityCounts.info} info`
  )
  if (report.suppressionAudit?.length) {
    const suppressed = summarizeDoctorReport(report).suppressedDiagnosticCount ?? 0
    lines.push(`Suppressions: ${suppressed} findings hidden; ${report.suppressionAudit.length} directives audited`)
  }
  if (report.run) {
    lines.push(`Target: ${report.run.target.mode} - ${report.run.target.files.length} files`)
  }

  if (report.coverage.status === 'complete') {
    lines.push(
      `Coverage: complete - ${formatCount(libraries.length, 'library', 'libraries')} inspected`
    )
  } else {
    const subjects: string[] = []
    if (affectedLibraries.length > 0) {
      const libraryText = affectedLibraries.length === 1 ? 'library needs' : 'libraries need'
      subjects.push(`${affectedLibraries.length} ${libraryText} attention`)
    }
    if (sourceNeedsAttention) {
      subjects.push(report.coverage.source.status === 'blocked'
        ? 'source scanning is unavailable'
        : 'source scan needs attention')
    }
    const incompletePacks = report.rulePacks?.filter((pack) => pack.coverageStatus !== 'complete') ?? []
    if (incompletePacks.length > 0) {
      subjects.push(`rule packs need evidence: ${incompletePacks.map((pack) => pack.name).join(', ')}`)
    }
    lines.push(`Coverage: ${report.coverage.status} - ${subjects.join('; ')}`)
  }

  for (const library of affectedLibraries) {
    const problemCodes = library.problems.map((problem) => problem.code)
    lines.push(
      `${library.package.canonicalName}: ${library.status}`
        + (problemCodes.length > 0 ? ` - ${problemCodes.join(', ')}` : '')
    )
  }

  if (sourceNeedsAttention) {
    const source = report.coverage.source
    if (source.status === 'blocked') {
      lines.push('source: blocked - scanning did not run')
    } else {
      const discoveryIssueCount = source.discoveryIssues?.length ?? 0
      const reasons = [
        source.failedFiles.length > 0
          ? `${formatCount(source.failedFiles.length, 'file')} failed to scan`
          : undefined,
        discoveryIssueCount > 0
          ? `${formatCount(discoveryIssueCount, 'scope issue')}`
          : undefined
      ].filter((reason): reason is string => reason !== undefined)
      lines.push(`source: partial - ${reasons.join(', ')}`)
    }
    for (const failure of source.failedFiles) {
      lines.push(`  ${failure.file}: ${failure.message}`)
    }
    for (const issue of source.discoveryIssues ?? []) {
      lines.push(`  ${issue.path}: ${issue.message}`)
    }
    for (const issue of source.contextIssues ?? []) {
      lines.push(`  ${issue.file ?? 'project context'}: ${issue.message}`)
    }
  }

  const domainNotes = report.domainCoverage?.flatMap((domain) => {
    const label = formatDomainLabel(domain.domain)
    if (domain.domain === 'vite' && domain.status === 'not-covered') {
      return [`${label}: not covered`]
    }
    if (domain.ruleCount === 0 || domain.status === 'complete') return []
    const details = [
      domain.pendingCheckCount > 0 ? `${domain.pendingCheckCount} pending acceptance` : undefined,
      domain.unavailableCheckCount > 0 ? `${domain.unavailableCheckCount} unavailable` : undefined,
      domain.unreportedCheckCount > 0 ? `${domain.unreportedCheckCount} not reported` : undefined
    ].filter((detail): detail is string => detail !== undefined)
    return [`${label}: ${domain.status}${details.length > 0 ? ` (${details.join(', ')})` : ''}`]
  }) ?? []
  if (domainNotes.length > 0) lines.push(`Domain coverage: ${domainNotes.join('; ')}`)

  if (report.checks) {
    const counts = new Map<string, number>()
    for (const check of report.checks) counts.set(check.status, (counts.get(check.status) ?? 0) + 1)
    lines.push(`Rule checks: ${[...counts].map(([status, count]) => `${status}=${count}`).join(', ')}`)
  }
  for (const pack of report.rulePacks ?? []) {
    if (!pack.checks) continue
    const counts = new Map<string, number>()
    for (const check of pack.checks) counts.set(check.status, (counts.get(check.status) ?? 0) + 1)
    lines.push(`Rule pack ${pack.name}: ${[...counts].map(([status, count]) => `${status}=${count}`).join(', ')}`)
    if (pack.checks.some((check) => !['checked', 'not-applicable', 'disabled'].includes(check.status))) {
      lines.push('  Acceptance is incomplete. Inspect rulePacks[].checks in JSON or the Inspector Coverage view for requirements.')
    }
  }

  if (count === 0) {
    const domainCoverageComplete = report.domainCoverage === undefined
      || report.domainCoverage.every((domain) => domain.status === 'complete')
    lines.push(
      report.coverage.status === 'complete' && domainCoverageComplete
        ? 'No diagnostics found.'
        : 'No diagnostics reported within current coverage.'
    )
  }

  if (!options.verbose && count > 10) {
    lines.push('', ...formatDiagnosticGroups(report))
  } else {
    for (const diagnostic of report.diagnostics) {
      lines.push('', ...formatDiagnostic(diagnostic))
    }
  }

  return `${lines.join('\n')}\n`
}

function formatDiagnosticGroups(report: DoctorReport): string[] {
  const groups = new Map<string, {
    code: string
    severity: Diagnostic['severity']
    count: number
    files: Set<string>
    samples: Diagnostic[]
  }>()
  for (const diagnostic of report.diagnostics) {
    const key = `${diagnostic.severity}\0${diagnostic.code}`
    let group = groups.get(key)
    if (!group) {
      group = { code: diagnostic.code, severity: diagnostic.severity, count: 0, files: new Set(), samples: [] }
      groups.set(key, group)
    }
    group.count++
    const file = diagnostic.primaryLocation?.file ?? diagnostic.file
    const path = file && (isAbsolute(file) ? relative(report.project.root, file) : file)
    if (group.samples.length < 2 && (!path || !group.files.has(path))) group.samples.push(diagnostic)
    if (path) group.files.add(path)
  }
  const rank = { error: 0, warning: 1, info: 2 }
  const sorted = [...groups.values()].sort((left, right) =>
    rank[left.severity] - rank[right.severity] || right.count - left.count
    || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
  const lines = [`Findings by rule: showing ${Math.min(8, sorted.length)} of ${sorted.length} groups (representative locations)`]
  for (const group of sorted.slice(0, 8)) {
    lines.push(`  ${group.severity} [${group.code}] ${formatCount(group.count, 'finding')}`
      + (group.files.size ? ` in ${formatCount(group.files.size, 'file')}` : ''))
    for (const diagnostic of group.samples) {
      const file = diagnostic.primaryLocation?.file ?? diagnostic.file
      const path = file && (isAbsolute(file) ? relative(report.project.root, file) : file)
      const evidence = diagnostic.primaryLocation ? undefined
        : diagnostic.evidence.find(item => item.file === file && item.line !== undefined)
      const line = diagnostic.primaryLocation?.start?.line ?? evidence?.line
      const column = diagnostic.primaryLocation?.start?.column ?? evidence?.column
      const location = path ? `${path}${line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`}` : ''
      const message = diagnostic.message.replace(/\s+/g, ' ').trim()
      lines.push(`    ${location ? `${location} - ` : ''}${message.length > 120 ? `${message.slice(0, 119)}…` : message}`)
    }
  }
  lines.push('', 'Use --verbose for every finding and its evidence; --inspect to browse; --json-out <file> to export the full report.')
  return lines
}

function getCoverageLibraries(report: DoctorReport): DoctorReport['coverage']['componentLibraries'] {
  const coverage = report.coverage as DoctorReport['coverage'] & {
    libraries?: DoctorReport['coverage']['componentLibraries']
  }
  return coverage.componentLibraries ?? coverage.libraries ?? []
}

function formatGateLine(
  summary: ReturnType<typeof summarizeDoctorReport>,
  failed: boolean
): string {
  if (failed) {
    if (summary.diagnosticCount > 0) {
      return `Result: failed (${summary.diagnosticCount} diagnostics, coverage ${summary.coverageStatus})\n`
    }
    return `Result: failed (coverage ${summary.coverageStatus})\n`
  }
  if (summary.isClean) {
    return 'Result: clean\n'
  }
  return `Result: passed with incomplete coverage (${summary.coverageStatus})\n`
}

function formatCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`
}

function formatDomainLabel(domain: NonNullable<DoctorReport['domainCoverage']>[number]['domain']): string {
  const labels: Record<typeof domain, string> = {
    'component-library': 'UI component library',
    styles: 'Styles',
    interaction: 'Interaction',
    vue: 'Vue syntax and API',
    vite: 'Vite',
    conventions: 'Conventions',
    unclassified: 'Unclassified'
  }
  return labels[domain]
}

function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines = [
    `[${diagnostic.code}] ${diagnostic.severity} ${diagnostic.confidence}`,
    diagnostic.message
  ]

  if (diagnostic.primaryLocation) {
    const { file, start, end, precision } = diagnostic.primaryLocation
    const coordinates = start ? `:${start.line}${start.column === undefined ? '' : `:${start.column}`}` : ''
    const range = end ? `–${end.line}:${end.column}` : ''
    lines.push(`file: ${file}${coordinates}${range} (${precision})`)
  } else if (diagnostic.file) {
    lines.push(`file: ${diagnostic.file}`)
  }

  const evidence = diagnostic.evidence.filter((entry) => entry.kind || entry.file || entry.message)
  if (evidence.length > 0) {
    lines.push('evidence:')
    for (const entry of evidence) {
      lines.push(`  - ${formatEvidence(entry)}`)
    }
  }

  if (diagnostic.fixes.length > 0) {
    lines.push('fixes: suggestions only')
    for (const fix of diagnostic.fixes) {
      lines.push(`  - ${fix.title}`)
      if (fix.description) {
        lines.push(`    ${fix.description}`)
      }
    }
  }

  return lines
}

function formatEvidence(evidence: EvidenceLocation): string {
  const location = [
    evidence.file,
    evidence.line === undefined ? undefined : `line ${evidence.line}`
  ].filter(Boolean).join(': ')
  const parts = [evidence.kind, location, evidence.message].filter(Boolean)

  return parts.join(' - ')
}

function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    isTTY: process.stderr.isTTY === true,
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  }
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isDirectRun()) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode
  })
}
