import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const eslintConfigNames = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts'
] as const

export interface ProjectEslintRuleState {
  ruleId: string
  severity: 0 | 1 | 2
  title?: string
  description?: string
  url?: string
}

export interface ProjectEslintFilePlan {
  filePath: string
  rules: ProjectEslintRuleState[]
}

export interface ProjectEslintPreparation {
  configFile: string
  eslintVersion: string
  files: ProjectEslintFilePlan[]
  rules: ProjectEslintRuleState[]
}

export interface ProjectEslintLintFile {
  filePath: string
  text: string
}

export interface ProjectEslintMessage {
  ruleId: string | null
  severity: 0 | 1 | 2
  message: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  fatal?: boolean
}

export interface ProjectEslintLintResult {
  filePath: string
  rules: ProjectEslintRuleState[]
  messages: ProjectEslintMessage[]
}

export interface ProjectEslintSession {
  root: string
  configFile: string
  eslintVersion: string
  discover(patterns: readonly string[]): Promise<string[]>
  prepare(files: readonly { filePath: string; text?: string }[]): Promise<ProjectEslintPreparation>
  lint(files: readonly ProjectEslintLintFile[]): Promise<ProjectEslintLintResult[]>
  dispose(): Promise<void>
}

export async function findProjectEslintConfig(options: {
  root: string
  searchStop?: string
  configFile?: string
}): Promise<string | undefined> {
  const root = resolve(options.root)
  if (options.configFile) {
    const explicit = isAbsolute(options.configFile)
      ? resolve(options.configFile)
      : resolve(options.searchStop ?? root, options.configFile)
    if (!await exists(explicit)) throw new Error(`Project ESLint config was not found: ${explicit}`)
    return explicit
  }
  const stop = resolve(options.searchStop ?? root)
  let directory = root
  while (true) {
    for (const name of eslintConfigNames) {
      const candidate = join(directory, name)
      if (await exists(candidate)) return candidate
    }
    if (directory === stop) return undefined
    const parent = resolve(directory, '..')
    if (parent === directory || !isInside(stop, parent)) return undefined
    directory = parent
  }
}

/**
 * Runs the consuming project's own ESLint in a fresh child process. This keeps
 * flat-config helper imports generation-scoped and prevents config/plugin
 * stdout from corrupting stdio hosts such as MCP.
 */
export async function createProjectEslintSession(options: {
  root: string
  configFile?: string
  /** Detected config; also anchors cwd-based lookup for scoped ESLint 9 projects. */
  discoveredConfigFile?: string
}): Promise<ProjectEslintSession> {
  const root = resolve(options.root)
  const configFile = options.configFile ? resolve(options.configFile) : undefined
  const discoveredConfigFile = options.discoveredConfigFile
    ? resolve(options.discoveredConfigFile)
    : configFile ?? await findProjectEslintConfig({ root })
  const child = spawn(process.execPath, ['--input-type=module', '--eval', PROJECT_ESLINT_WORKER], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'ignore', 'pipe']
  })
  const channel = child.stdio[3]
  if (!channel) {
    child.kill()
    throw new Error('Could not create the isolated project ESLint channel.')
  }
  const rpc = createRpc(
    child as unknown as ChildProcessWithoutNullStreams,
    channel as NodeJS.ReadableStream
  )
  try {
    const initialized = await rpc.request<{ eslintVersion: string; configFile: string }>('init', {
      root,
      configFile,
      discoveredConfigFile
    })
    return {
      root,
      configFile: initialized.configFile,
      eslintVersion: initialized.eslintVersion,
      discover(patterns) {
        return rpc.request<string[]>('discover', { patterns: [...patterns] })
      },
      prepare(files) {
        return rpc.request<ProjectEslintPreparation>('prepare', { files: [...files] })
      },
      lint(files) {
        return rpc.request<ProjectEslintLintResult[]>('lint', { files: [...files] })
      },
      dispose: rpc.dispose
    }
  } catch (error) {
    await rpc.dispose()
    throw error
  }
}

function createRpc(child: ChildProcessWithoutNullStreams, channel: NodeJS.ReadableStream): {
  request<T>(method: string, params: unknown): Promise<T>
  dispose(): Promise<void>
} {
  let nextId = 1
  let buffer = ''
  let disposed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const rejectAll = (message: string) => {
    for (const item of pending.values()) item.reject(new Error(message))
    pending.clear()
  }
  channel.setEncoding('utf8')
  channel.on('data', (chunk: string) => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let response: { id: number; result?: unknown; error?: string }
      try {
        response = JSON.parse(line) as typeof response
      } catch {
        rejectAll('Project ESLint returned an invalid isolated-process response.')
        continue
      }
      const item = pending.get(response.id)
      if (!item) continue
      pending.delete(response.id)
      if (response.error) item.reject(new Error(response.error))
      else item.resolve(response.result)
    }
  })
  child.once('error', error => rejectAll(`Project ESLint process failed: ${error.message}`))
  child.once('exit', code => {
    if (!disposed) rejectAll(`Project ESLint process exited unexpectedly${code === null ? '' : ` with code ${code}`}.`)
  })
  return {
    request<T>(method: string, params: unknown): Promise<T> {
      if (disposed) return Promise.reject(new Error('Project ESLint session is closed.'))
      const id = nextId++
      return new Promise<T>((resolvePromise, reject) => {
        pending.set(id, { resolve: value => resolvePromise(value as T), reject })
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
          if (!error) return
          pending.delete(id)
          reject(error)
        })
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      rejectAll('Project ESLint session was closed.')
      child.stdin.end()
      if (await waitForChildExit(child, 250)) return
      child.kill('SIGTERM')
      if (await waitForChildExit(child, 500)) return
      child.kill('SIGKILL')
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()))
    }
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>(resolvePromise => {
    const onExit = () => {
      clearTimeout(timeout)
      resolvePromise(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    timeout.unref()
    child.once('exit', onExit)
  })
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = `${resolve(root)}/`
  const normalizedCandidate = `${resolve(candidate)}/`
  return normalizedCandidate.startsWith(normalizedRoot)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const PROJECT_ESLINT_WORKER = String.raw`
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const output = createWriteStream(null, { fd: 3 })
let discovery
let eslint
let root
let configFile
let eslintVersion
let builtinRules
const observerPlugin = '@vue-doctor/snapshot'
const observerRuleId = observerPlugin + '/observe'
const observedVirtualFiles = new Set()
let discoveryFile
const observedRulesByFile = new Map()
let formalFile
const formalRulesByFile = new Map()

function respond(value) { output.write(JSON.stringify(value) + '\n') }
function severity(entry) {
  const value = Array.isArray(entry) ? entry[0] : entry
  if (value === 2 || value === 'error') return 2
  if (value === 1 || value === 'warn' || value === 'warning') return 1
  return 0
}
function stableRules(config) {
  return Object.entries(config?.rules ?? {}).filter(([ruleId]) => ruleId !== observerRuleId).map(([ruleId, entry]) => {
    const pluginName = Object.keys(config?.plugins ?? {})
      .filter(name => ruleId.startsWith(name + '/'))
      .sort((left, right) => right.length - left.length)[0]
    const localName = pluginName ? ruleId.slice(pluginName.length + 1) : undefined
    const module = pluginName && localName
      ? config.plugins?.[pluginName]?.rules?.[localName]
      : builtinRules.get(ruleId)
    const description = module?.meta?.docs?.description
    const url = module?.meta?.docs?.url
    return {
      ruleId,
      severity: severity(entry),
      ...(description ? { title: description, description } : {}),
      ...(url ? { url } : {})
    }
  })
    .sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0)
}
function mergeRules(...groups) {
  const merged = new Map()
  for (const group of groups) {
    for (const rule of group) {
      const previous = merged.get(rule.ruleId)
      merged.set(rule.ruleId, { ...previous, ...rule, severity: Math.max(previous?.severity ?? 0, rule.severity) })
    }
  }
  return [...merged.values()].sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0)
}
async function initialize(params) {
  root = resolve(params.root)
  const overrideConfigFile = params.configFile ? resolve(params.configFile) : undefined
  configFile = overrideConfigFile ?? (params.discoveredConfigFile ? resolve(params.discoveredConfigFile) : undefined)
  const require = createRequire(join(root, 'package.json'))
  let apiPath
  let packagePath
  try {
    apiPath = require.resolve('eslint')
    packagePath = require.resolve('eslint/package.json')
  } catch {
    throw new Error('Project ESLint config was found, but this package cannot resolve its own eslint installation.')
  }
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  eslintVersion = String(packageJson.version ?? '')
  const major = Number(eslintVersion.split('.')[0])
  if (!Number.isInteger(major) || major < 9) {
    throw new Error('Project ESLint mode requires the consuming package to install ESLint 9 or newer; resolved ' + (eslintVersion || 'an unknown version') + '.')
  }
  const api = await import(pathToFileURL(apiPath).href)
  if (typeof api.ESLint !== 'function') throw new Error('The consuming eslint package does not expose the ESLint Node API.')
  if (!configFile) throw new Error('Project ESLint config lookup did not find an eslint.config.* file.')
  const builtinApi = await import(pathToFileURL(require.resolve('eslint/use-at-your-own-risk')).href)
  builtinRules = builtinApi.builtinRules
  const common = {
    // ESLint 9 searches from cwd, while ESLint 10 searches from each target file.
    cwd: major === 9 && !overrideConfigFile && configFile.startsWith(root + sep) ? dirname(configFile) : root,
    ...(overrideConfigFile ? { overrideConfigFile } : {}),
    cache: false,
    fix: false,
    errorOnUnmatchedPattern: false,
    warnIgnored: false
  }
  discovery = new api.ESLint({
    ...common,
    overrideConfig: {
      plugins: {
        [observerPlugin]: { rules: { observe: {
          meta: { schema: [] },
          create(context) {
            if (discoveryFile) observedVirtualFiles.add(context.filename)
            return {}
          }
        } } }
      },
      rules: { [observerRuleId]: 'warn' }
    },
    ruleFilter: rule => {
      if (rule.ruleId === observerRuleId) return Boolean(discoveryFile)
      if (discoveryFile) {
        const observed = observedRulesByFile.get(discoveryFile) ?? new Map()
        const previous = observed.get(rule.ruleId)
        observed.set(rule.ruleId, { ruleId: rule.ruleId, severity: Math.max(previous?.severity ?? 0, rule.severity) })
        observedRulesByFile.set(discoveryFile, observed)
      }
      return false
    }
  })
  eslint = new api.ESLint({ ...common, ruleFilter: rule => {
    if (formalFile) {
      const observed = formalRulesByFile.get(formalFile) ?? new Map()
      observed.set(rule.ruleId, { ruleId: rule.ruleId, severity: rule.severity })
      formalRulesByFile.set(formalFile, observed)
    }
    return true
  } })
  return { eslintVersion, configFile }
}
async function discover(params) {
  if (!discovery) throw new Error('Project ESLint is not initialized.')
  const results = params.patterns.length > 0
    ? await discovery.lintFiles(params.patterns.map(pattern => resolve(root, pattern)))
    : []
  const files = []
  for (const result of results) {
    const filePath = resolve(result.filePath)
    if (await discovery.calculateConfigForFile(filePath)) files.push(filePath)
  }
  return files.sort()
}
async function prepare(params) {
  if (!discovery) throw new Error('Project ESLint is not initialized.')
  // Force official config loading even when the selected scope contains zero files.
  const configuredRules = new Map()
  const probeRoot = dirname(configFile)
  for (const extension of ['js', 'ts', 'vue']) {
    const config = await discovery.calculateConfigForFile(join(probeRoot, '__vue_doctor_config_probe__.' + extension))
    for (const rule of stableRules(config)) {
      const previous = configuredRules.get(rule.ruleId)
      configuredRules.set(rule.ruleId, { ...previous, ...rule, severity: Math.max(previous?.severity ?? 0, rule.severity) })
    }
  }
  const files = []
  for (const file of params.files) {
    const filePath = resolve(file.filePath)
    const config = await discovery.calculateConfigForFile(filePath)
    observedRulesByFile.delete(filePath)
    observedVirtualFiles.clear()
    let messages = []
    if (file.text !== undefined) {
      discoveryFile = filePath
      try {
        const results = await discovery.lintText(file.text, { filePath, warnIgnored: false })
        messages = results.flatMap(result => result.messages)
      }
      finally { discoveryFile = undefined }
    }
    const observed = [...(observedRulesByFile.get(filePath)?.values() ?? [])]
    const virtualRules = []
    for (const virtualFile of observedVirtualFiles) {
      if (virtualFile !== filePath) {
        virtualRules.push(...stableRules(await discovery.calculateConfigForFile(virtualFile)))
      }
    }
    // Unknown rules in inline directives are ESLint diagnostics even when no rule executes.
    const reportedRules = messages.filter(message => message.ruleId && message.ruleId !== observerRuleId)
      .map(message => ({ ruleId: message.ruleId, severity: message.severity }))
    const rules = mergeRules(stableRules(config), virtualRules, observed, reportedRules)
    for (const rule of rules) {
      const previous = configuredRules.get(rule.ruleId)
      configuredRules.set(rule.ruleId, { ...previous, ...rule, severity: Math.max(previous?.severity ?? 0, rule.severity) })
    }
    if (config) files.push({ filePath, rules })
  }
  files.sort((left, right) => left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0)
  return {
    configFile,
    eslintVersion,
    files,
    rules: [...configuredRules].map(([ruleId, rule]) => ({ ruleId, ...rule }))
      .sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0)
  }
}
async function lint(params) {
  if (!eslint) throw new Error('Project ESLint is not initialized.')
  const output = []
  for (const file of params.files) {
    const filePath = resolve(file.filePath)
    formalRulesByFile.delete(filePath)
    formalFile = filePath
    let results
    try { results = await eslint.lintText(file.text, { filePath, warnIgnored: false }) }
    finally { formalFile = undefined }
    const rules = [...(formalRulesByFile.get(filePath)?.values() ?? [])]
      .sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0)
    for (const result of results) {
      output.push({
        filePath: resolve(result.filePath),
        rules,
        messages: result.messages.map(message => ({
          ruleId: message.ruleId ?? null,
          severity: message.severity,
          message: message.message,
          ...(message.line === undefined ? {} : { line: message.line }),
          ...(message.column === undefined ? {} : { column: message.column }),
          ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
          ...(message.endColumn === undefined ? {} : { endColumn: message.endColumn }),
          ...(message.fatal === undefined ? {} : { fatal: message.fatal })
        }))
      })
    }
  }
  return output
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (!line) continue
  let request
  try {
    request = JSON.parse(line)
    const result = request.method === 'init'
      ? await initialize(request.params)
      : request.method === 'discover'
        ? await discover(request.params)
        : request.method === 'prepare'
          ? await prepare(request.params)
          : request.method === 'lint'
            ? await lint(request.params)
            : (() => { throw new Error('Unknown project ESLint method: ' + request.method) })()
    respond({ id: request.id, result })
  } catch (error) {
    respond({ id: request?.id ?? -1, error: error instanceof Error ? error.message : String(error) })
  }
}
`
