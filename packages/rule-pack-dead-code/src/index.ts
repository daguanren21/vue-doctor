import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Diagnostic, DoctorRuleDefinition, DoctorRulePack, DoctorRulePackResult } from '@vue-doctor/core'
import { analyzeProject, type KnipIssue, type KnipIssueType } from './knip.js'

export interface DeadCodeRulePackOptions {
  /** Knip config path, relative to the Doctor root. Omit to use Knip's config discovery. */
  configFile?: string
  /** Kill an unfinished analysis and report unavailable checks. Default: 120000ms. */
  timeoutMs?: number
}

const definitions: Record<KnipIssueType, DoctorRuleDefinition> = {
  files: {
    code: 'dead-code/unused-file',
    title: 'Unused file',
    description: 'Find files not reachable from configured project entry points.'
  },
  exports: {
    code: 'dead-code/unused-export',
    title: 'Unused export',
    description: 'Find exported values without consumers in the project graph.'
  },
  types: {
    code: 'dead-code/unused-type',
    title: 'Unused exported type',
    description: 'Find exported types, interfaces and enums without consumers in the project graph.'
  },
  duplicates: {
    code: 'dead-code/duplicate-export',
    title: 'Duplicate export',
    description: 'Find symbols exported more than once from the same module.'
  }
}
const types = Object.keys(definitions) as KnipIssueType[]
const rules: DoctorRuleDefinition[] = types.map(type => ({
  ...definitions[type],
  domain: 'conventions',
  tags: ['dead-code', 'knip', 'project-graph'],
  verification: 'static',
  defaultSeverity: 'warning',
  help: {
    problem: definitions[type].description,
    remediation: 'Check Knip entry/project patterns, framework plugins and dynamic consumers before removing or consolidating code.'
  }
}))

/** Opt-in project-graph analysis. Source selection limits findings, not the graph. */
export function createDeadCodeRulePack(options: DeadCodeRulePackOptions = {}): DoctorRulePack {
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('Dead-code timeoutMs must be a positive integer no greater than 2147483647.')
  }
  const configFile = options.configFile
  return {
    name: 'dead-code',
    rules,
    sourceExtensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'],
    async run(context) {
      const active = types.filter(type => context.rules[definitions[type].code] !== 'off')
      const result: DoctorRulePackResult = {
        diagnostics: [],
        skippedChecks: [],
        checks: types.map(type => ({
          ruleCode: definitions[type].code,
          status: active.includes(type) ? 'checked' : 'disabled'
        }))
      }
      if (!active.length) return result
      const logicalRoot = resolve(context.inventory.root)
      const targetFiles = context.targetFiles?.files ?? context.source.files
      if (!targetFiles.length) {
        for (const check of result.checks!) {
          if (check.status === 'checked') {
            check.status = 'not-applicable'
            check.reason = 'No source files selected; project graph analysis was not run.'
          }
        }
        return result
      }
      try {
        // Knip's native resolver uses real paths; its entry graph must use the same identity.
        const root = await realpath(logicalRoot)
        const selected = new Map<string, string>()
        for (const target of targetFiles) {
          const absolute = resolve(logicalRoot, target)
          const physical = await realpath(absolute)
          const physicalRelative = relative(root, physical)
          if (!isProjectRelative(physicalRelative)) throw new Error(`Selected file resolves outside the Doctor root: ${target}`)
          const logicalRelative = relative(logicalRoot, absolute)
          selected.set(physical, isProjectRelative(logicalRelative) ? logicalRelative : physicalRelative)
        }
        const issues = await analyzeProject({
          root, types: active, timeoutMs,
          ...(configFile ? { configFile: await realpath(resolve(logicalRoot, configFile)) } : {})
        })
        for (const issue of issues) {
          const file = selected.get(resolve(root, issue.filePath))
          if (file === undefined) continue
          const code = definitions[issue.type].code
          const severity = context.rules[code] ?? 'warning'
          if (severity === 'off') continue
          result.diagnostics.push(diagnostic(issue, file.split(sep).join('/'), code, severity))
        }
      } catch (error) {
        result.diagnostics.length = 0
        const message = error instanceof Error ? error.message : String(error)
        for (const check of result.checks!) {
          if (check.status === 'disabled') continue
          check.status = 'unavailable'
          check.reason = message
          result.skippedChecks.push({
            ruleCode: check.ruleCode,
            required: true,
            reason: 'missing-capability',
            evidence: [{ kind: 'knip', message }]
          })
        }
      }
      return result
    }
  }
}

function diagnostic(issue: KnipIssue, file: string, code: string, severity: Diagnostic['severity']): Diagnostic {
  const location = issue.line === undefined ? issue.symbols?.[0] : issue
  const line = location?.line
  const column = location?.col
  const message = issue.type === 'files'
    ? 'File is not reachable from the configured Knip entry points.'
    : issue.type === 'duplicates'
      ? `Symbol is exported more than once: ${issue.symbols?.map(symbol => symbol.symbol).join(', ') ?? issue.symbol}.`
      : `Export ${JSON.stringify(issue.symbol)} has no consumers in the configured Knip project graph.`
  return {
    code, severity, file, message,
    confidence: 'medium',
    primaryLocation: {
      file,
      ...(line === undefined ? {} : { start: { line, ...(column === undefined ? {} : { column }) } }),
      precision: line === undefined ? 'file' : column === undefined ? 'line' : 'point'
    },
    evidence: [{
      kind: 'knip', file,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      message: `Knip ${issue.type}: ${issue.symbol}`
    }],
    fixes: [{ title: 'Verify entry points and dynamic consumers before removing or consolidating this code.' }]
  }
}

function isProjectRelative(file: string): boolean {
  return file !== '..' && !file.startsWith(`..${sep}`) && !isAbsolute(file)
}
