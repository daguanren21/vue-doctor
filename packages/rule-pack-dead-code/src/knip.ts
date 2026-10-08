import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type KnipIssueType = 'files' | 'exports' | 'types' | 'duplicates'

export interface KnipIssue {
  type: KnipIssueType
  filePath: string
  symbol: string
  line?: number
  col?: number
  symbols?: Array<{ symbol: string; line?: number; col?: number }>
}

interface KnipResponse {
  issues?: KnipIssue[]
  error?: string
}

export async function analyzeProject(options: {
  root: string
  types: KnipIssueType[]
  configFile?: string
  timeoutMs: number
}): Promise<KnipIssue[]> {
  const api = pathToFileURL(createRequire(import.meta.url).resolve('knip/session')).href
  // An IPC channel keeps project config logging separate from both Doctor and the response.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', KNIP_WORKER, api, JSON.stringify(options)], {
    cwd: options.root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let response: KnipResponse | undefined
  const deadline = new AbortController()
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
  child.on('message', message => { response = message as KnipResponse })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    deadline.abort()
  }, options.timeoutMs)
  timer.unref()
  try {
    const [code, signal] = await once(child, 'close', { signal: deadline.signal })
    const error = response?.error
      ?? (code !== 0 ? `Knip process exited with ${signal ?? code}.` : undefined)
      ?? (!Array.isArray(response?.issues) ? 'Knip returned no analysis result.' : undefined)
    if (error) throw new Error([error, stderr.trim()].filter(Boolean).join('\n'))
    return response!.issues!
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error([`Knip project analysis timed out after ${options.timeoutMs}ms.`, stderr.trim()].filter(Boolean).join('\n'))
    }
    throw error
  } finally {
    clearTimeout(timer)
    child.stderr?.destroy()
    if (child.connected) child.disconnect()
  }
}

// Like the project ESLint worker, this self-contained module works from source and bundled packages.
const KNIP_WORKER = String.raw`
import { access } from 'node:fs/promises'
import { join, relative } from 'node:path'

function finish(response) {
  process.send(response, error => process.exit(error ? 1 : 0))
}

try {
  const request = JSON.parse(process.argv[2])
  await access(join(request.root, 'package.json'))
  const { createOptions, createSession, ISSUE_TYPES } = await import(process.argv[1])
  const included = new Set([...request.types, 'unresolved'])
  const options = await createOptions({
    cwd: request.root,
    args: request.configFile ? { config: request.configFile } : {},
    includedIssueTypes: [...included],
    excludedIssueTypes: ISSUE_TYPES.filter(type => !included.has(type)),
    isSession: true,
    isUseTscFiles: false,
    isShowProgress: false,
    isFix: false
  })
  // Doctor owns issue selection/severity; Knip owns entries, project files and graph ignores.
  for (const type of included) options.rules[type] = 'warn'
  const session = await createSession(options)
  const result = session.getResults()
  const problems = []
  if (result.hasConfigLoadErrors) problems.push('Knip could not load one or more project/plugin configurations.')
  for (const records of Object.values(result.issues.unresolved)) {
    for (const issue of Object.values(records)) {
      problems.push('Unresolved import ' + JSON.stringify(issue.symbol) + ' in ' + relative(request.root, issue.filePath))
    }
  }
  const incompleteHints = new Set([
    'entry-empty', 'project-empty', 'package-entry', 'project-extension-unregistered',
    'entry-top-level', 'project-top-level',
    'project-extension-excluded', 'workspace-unconfigured', 'top-level-unconfigured'
  ])
  for (const hint of result.configurationHints) {
    if (incompleteHints.has(hint.type)) problems.push('Knip ' + hint.type + ': ' + String(hint.identifier))
  }
  if (problems.length) {
    finish({ error: problems.join('\n') })
  } else {
    const issues = request.types.flatMap(type => Object.values(result.issues[type]).flatMap(records =>
      Object.values(records).map(({ filePath, symbol, line, col, symbols }) => ({ type, filePath, symbol, line, col, symbols }))
    ))
    finish({ issues })
  }
} catch (error) {
  finish({ error: error instanceof Error ? error.message : String(error) })
}
`
