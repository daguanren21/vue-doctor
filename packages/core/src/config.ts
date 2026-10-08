import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { validateDoctorRulePacks } from './rule-packs.js'
import type {
  Diagnostic,
  DiagnosticSeverity,
  DoctorConfig,
  DoctorRunOptions,
  RuleSeveritySetting,
  UiLibraryConfig
} from './types.js'

const CONFIG_BASENAMES = [
  'doctor.config.ts',
  'doctor.config.mts',
  'doctor.config.js',
  'doctor.config.mjs',
  'doctor.config.cjs',
  'doctor.config.json',
  'vue-doctor.config.ts',
  'vue-doctor.config.mts',
  'vue-doctor.config.js',
  'vue-doctor.config.mjs',
  'vue-doctor.config.cjs',
  'vue-doctor.config.json'
] as const

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  info: 1,
  warning: 2,
  error: 3
}

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config
}

export async function loadDoctorConfig(options: {
  root?: string
  configFile?: string
} = {}): Promise<{ config: DoctorConfig; path?: string }> {
  const root = resolve(options.root ?? process.cwd())
  const explicit = options.configFile
    ? (isAbsolute(options.configFile) ? options.configFile : resolve(root, options.configFile))
    : undefined

  if (explicit) {
    return {
      config: normalizeDoctorConfig(await readConfigModule(explicit)),
      path: explicit
    }
  }

  for (const basename of CONFIG_BASENAMES) {
    const candidate = join(root, basename)
    if (!(await exists(candidate))) {
      continue
    }
    return {
      config: normalizeDoctorConfig(await readConfigModule(candidate)),
      path: candidate
    }
  }

  const packageJsonPath = join(root, 'package.json')
  if (await exists(packageJsonPath)) {
    let embedded: unknown
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        vueDoctor?: unknown
        'vue-doctor'?: unknown
      }
      embedded = packageJson.vueDoctor ?? packageJson['vue-doctor']
    } catch {
      // Ignore invalid package.json and fall through to empty config.
    }
    if (embedded && typeof embedded === 'object') {
      return { config: normalizeDoctorConfig(embedded), path: packageJsonPath }
    }
  }

  return { config: {} }
}

export function mergeDoctorConfig(...configs: Array<DoctorConfig | undefined>): DoctorConfig {
  const merged: DoctorConfig = {}
  for (const input of configs) {
    if (!input) continue
    const config = normalizeDoctorConfig(input)
    if (config.scope !== undefined) merged.scope = config.scope
    if (config.failOn !== undefined) merged.failOn = config.failOn
    if (config.failOnIncompleteCoverage !== undefined) {
      merged.failOnIncompleteCoverage = config.failOnIncompleteCoverage
    }
    if (config.gitAttribution !== undefined) merged.gitAttribution = config.gitAttribution
    if (config.rulePacks !== undefined) {
      validateDoctorRulePacks(config.rulePacks)
      merged.rulePacks = [...config.rulePacks]
    }
    if (config.rules) {
      merged.rules = { ...merged.rules, ...config.rules }
    }
    if (config.ui) {
      merged.ui = {
        ...merged.ui,
        ...config.ui,
        ...(config.ui.libraries ? { libraries: [...config.ui.libraries] } : {})
      }
    }
    if (config.eslint) merged.eslint = { ...config.eslint }
  }
  return merged
}

export function applyDoctorConfigToDiagnostics(
  diagnostics: Diagnostic[],
  config: DoctorConfig | undefined
): Diagnostic[] {
  if (!config?.rules || Object.keys(config.rules).length === 0) {
    return diagnostics
  }

  const next: Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const setting = resolveRuleSetting(diagnostic.code, config.rules)
    if (setting === 'off') {
      continue
    }
    if (!setting) {
      next.push(diagnostic)
      continue
    }
    next.push({
      ...diagnostic,
      severity: setting
    })
  }
  return next
}

export function resolveDoctorRunOptions(options: DoctorRunOptions = {}, config: DoctorConfig = {}): DoctorRunOptions {
  return {
    ...options,
    scope: options.scope ?? config.scope,
    config
  }
}

export function resolveConfiguredUiLibraries(config: DoctorConfig = {}): UiLibraryConfig[] {
  return (config.ui?.libraries ?? []).map((library) => (
    typeof library === 'string'
      ? { package: library }
      : { package: library.package, ...(library.aliases ? { aliases: [...library.aliases] } : {}) }
  ))
}

export function shouldFailDoctorRun(options: {
  diagnostics: Diagnostic[]
  coverageStatus: 'complete' | 'partial' | 'blocked'
  config?: DoctorConfig
}): boolean {
  const config = options.config ?? {}
  // Default is non-blocking unless the consumer opts into a fail threshold.
  const failOn = config.failOn ?? 'never'
  if (failOn !== 'never') {
    const threshold = SEVERITY_RANK[failOn]
    if (options.diagnostics.some((item) => SEVERITY_RANK[item.severity] >= threshold)) {
      return true
    }
  }
  if (config.failOnIncompleteCoverage && options.coverageStatus !== 'complete') {
    return true
  }
  return false
}

function resolveRuleSetting(
  code: string,
  rules: Record<string, RuleSeveritySetting>
): RuleSeveritySetting | undefined {
  if (Object.prototype.hasOwnProperty.call(rules, code)) {
    return rules[code]
  }
  return undefined
}

function normalizeDoctorConfig(value: unknown): DoctorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Doctor config must be an object.')
  }

  const input = value as Record<string, unknown>
  const config: DoctorConfig = {}

  if (input.scope !== undefined) {
    if (typeof input.scope !== 'string' || input.scope.trim() === '') {
      throw new Error('Doctor config "scope" must be a non-empty string.')
    }
    config.scope = input.scope
  }

  if (input.rulePacks !== undefined) {
    validateDoctorRulePacks(input.rulePacks)
    config.rulePacks = [...input.rulePacks]
  }

  if (input.failOn !== undefined) {
    if (!isFailOn(input.failOn)) {
      throw new Error('Doctor config "failOn" must be one of error|warning|info|never.')
    }
    config.failOn = input.failOn
  }

  if (input.failOnIncompleteCoverage !== undefined) {
    if (typeof input.failOnIncompleteCoverage !== 'boolean') {
      throw new Error('Doctor config "failOnIncompleteCoverage" must be a boolean.')
    }
    config.failOnIncompleteCoverage = input.failOnIncompleteCoverage
  }

  if (input.gitAttribution !== undefined) {
    if (typeof input.gitAttribution !== 'boolean') {
      throw new Error('Doctor config "gitAttribution" must be a boolean.')
    }
    config.gitAttribution = input.gitAttribution
  }

  if (input.rules !== undefined) {
    if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) {
      throw new Error('Doctor config "rules" must be an object.')
    }
    const rules: Record<string, RuleSeveritySetting> = {}
    for (const [code, setting] of Object.entries(input.rules as Record<string, unknown>)) {
      if (!isRuleSeveritySetting(setting)) {
        throw new Error(`Doctor config rules["${code}"] must be error|warning|info|off.`)
      }
      rules[code] = setting
    }
    config.rules = rules
  }

  if (input.ui !== undefined) {
    if (!input.ui || typeof input.ui !== 'object' || Array.isArray(input.ui)) {
      throw new Error('Doctor config "ui" must be an object.')
    }
    const inputUi = input.ui as Record<string, unknown>
    const ui: NonNullable<DoctorConfig['ui']> = {}
    if (inputUi.autoDetect !== undefined) {
      if (typeof inputUi.autoDetect !== 'boolean') {
        throw new Error('Doctor config "ui.autoDetect" must be a boolean.')
      }
      ui.autoDetect = inputUi.autoDetect
    }
    if (inputUi.runtimeContracts !== undefined) {
      if (typeof inputUi.runtimeContracts !== 'boolean') {
        throw new Error('Doctor config "ui.runtimeContracts" must be a boolean.')
      }
      ui.runtimeContracts = inputUi.runtimeContracts
    }
    if (inputUi.libraries !== undefined) {
      if (!Array.isArray(inputUi.libraries)) {
        throw new Error('Doctor config "ui.libraries" must be an array.')
      }
      ui.libraries = inputUi.libraries.map((library, index) => normalizeUiLibrary(library, index))
    }
    config.ui = ui
  }

  if (input.eslint !== undefined) {
    if (!input.eslint || typeof input.eslint !== 'object' || Array.isArray(input.eslint)) {
      throw new Error('Doctor config "eslint" must be an object.')
    }
    const inputEslint = input.eslint as Record<string, unknown>
    const eslint: NonNullable<DoctorConfig['eslint']> = {}
    if (inputEslint.mode !== undefined) {
      if (!['auto', 'project', 'builtin', 'off'].includes(String(inputEslint.mode))) {
        throw new Error('Doctor config "eslint.mode" must be one of auto|project|builtin|off.')
      }
      eslint.mode = inputEslint.mode as NonNullable<DoctorConfig['eslint']>['mode']
    }
    if (inputEslint.configFile !== undefined) {
      if (typeof inputEslint.configFile !== 'string' || inputEslint.configFile.trim() === '') {
        throw new Error('Doctor config "eslint.configFile" must be a non-empty string.')
      }
      eslint.configFile = inputEslint.configFile.trim()
    }
    if (eslint.configFile && eslint.mode === 'builtin') {
      throw new Error('Doctor config "eslint.configFile" cannot be used with eslint.mode "builtin".')
    }
    if (eslint.configFile && eslint.mode === 'off') {
      throw new Error('Doctor config "eslint.configFile" cannot be used with eslint.mode "off".')
    }
    config.eslint = eslint
  }


  return config
}

function normalizeUiLibrary(value: unknown, index: number): string | UiLibraryConfig {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new Error(`Doctor config "ui.libraries[${index}]" must be a non-empty package name.`)
    }
    return value.trim()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Doctor config "ui.libraries[${index}]" must be a package name or object.`)
  }

  const input = value as Record<string, unknown>
  if (typeof input.package !== 'string' || input.package.trim() === '') {
    throw new Error(`Doctor config "ui.libraries[${index}].package" must be a non-empty string.`)
  }
  if (input.aliases !== undefined && !Array.isArray(input.aliases)) {
    throw new Error(`Doctor config "ui.libraries[${index}].aliases" must be an array.`)
  }

  const aliases = (input.aliases ?? []).map((alias, aliasIndex) => {
    if (typeof alias !== 'string' || alias.trim() === '') {
      throw new Error(`Doctor config "ui.libraries[${index}].aliases[${aliasIndex}]" must be a non-empty string.`)
    }
    return alias.trim()
  })
  return {
    package: input.package.trim(),
    ...(aliases.length > 0 ? { aliases: [...new Set(aliases)] } : {})
  }
}

async function readConfigModule(path: string): Promise<unknown> {
  if (path.endsWith('.json')) {
    return JSON.parse(await readFile(path, 'utf8'))
  }
  // A fresh evaluator prevents a long-lived analysis session from retaining
  // the config module or one of its local imports between generations.
  const configLoader = createJiti(import.meta.url, {
    interopDefault: true,
    fsCache: false,
    moduleCache: false
  })
  let evaluated: unknown
  try {
    evaluated = await configLoader.evalModule(await readFile(path, 'utf8'), {
      filename: path,
      // Synchronous evaluation makes jiti transpile local ESM dependencies too.
      // Native async import would retain those dependencies in Node's global ESM
      // cache even though this evaluator itself is fresh for every generation.
      async: false,
      forceTranspile: true
    })
  } catch (error) {
    if (error instanceof SyntaxError && /await is only valid/.test(error.message)) {
      throw new Error('Doctor config modules and their local imports do not support top-level await. Export configuration synchronously and put asynchronous analysis in rule pack run().', { cause: error })
    }
    throw error
  }
  return evaluated && typeof evaluated === 'object' && 'default' in evaluated
    ? (evaluated as { default: unknown }).default
    : evaluated
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isFailOn(value: unknown): value is NonNullable<DoctorConfig['failOn']> {
  return value === 'error' || value === 'warning' || value === 'info' || value === 'never'
}

function isRuleSeveritySetting(value: unknown): value is RuleSeveritySetting {
  return value === 'error' || value === 'warning' || value === 'info' || value === 'off'
}
