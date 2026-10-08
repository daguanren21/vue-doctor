import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Diagnostic, GitAttribution } from '@vue-doctor/core'
import pMap from 'p-map'

const execFileAsync = promisify(execFile)
const zeroCommit = /^0+$/

export type GitCommandRunner = (cwd: string, args: string[]) => Promise<string>

export async function enrichDiagnosticsWithGitAttribution(
  projectRoot: string,
  diagnostics: Diagnostic[],
  runGit: GitCommandRunner = executeGit
): Promise<Diagnostic[]> {
  const gitRoot = await resolveGitRoot(projectRoot, runGit)
  if (!gitRoot) return diagnostics
  const requests = collectBlameRequests(projectRoot, gitRoot, diagnostics)
  if (requests.size === 0) return diagnostics

  const attributions = new Map<string, Map<number, GitAttribution>>()
  await pMap([...requests], async ([file, lines]) => {
    const ordered = [...lines].sort((first, second) => first - second)
    if (ordered.length === 0) return
    const ranges = ordered.flatMap((line) => ['-L', `${line},${line}`])
    try {
      const output = await runGit(gitRoot, [
        'blame',
        '--line-porcelain',
        ...ranges,
        '--',
        relative(gitRoot, file)
      ])
      attributions.set(file, parseGitBlamePorcelain(output))
    } catch {
      // Files outside history, shallow repositories, and unavailable Git should not block diagnosis.
    }
  }, { concurrency: 4 })

  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    evidence: diagnostic.evidence.map((entry) => {
      if (!entry.file || entry.line === undefined) return entry
      const file = resolveEvidenceFile(projectRoot, entry.file)
      const git = attributions.get(file)?.get(entry.line)
      return git ? { ...entry, git } : entry
    })
  }))
}

export function parseGitBlamePorcelain(output: string): Map<number, GitAttribution> {
  const result = new Map<number, GitAttribution>()
  const lines = output.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^([0-9a-f]+)\s+\d+\s+(\d+)(?:\s+\d+)?$/i.exec(lines[index] ?? '')
    if (!header) continue
    const commit = header[1]!
    const finalLine = Number(header[2])
    let authorName = ''
    let authorTime: number | undefined
    let summary: string | undefined
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.startsWith('\t')) break
      if (line.startsWith('author ')) authorName = line.slice('author '.length)
      if (line.startsWith('author-time ')) authorTime = Number(line.slice('author-time '.length))
      if (line.startsWith('summary ')) summary = line.slice('summary '.length)
    }
    if (!Number.isInteger(finalLine) || !authorName) continue
    const uncommitted = zeroCommit.test(commit)
    result.set(finalLine, {
      commit,
      authorName,
      ...(authorTime && authorTime > 0 ? { authoredAt: new Date(authorTime * 1000).toISOString() } : {}),
      ...(summary ? { summary } : {}),
      ...(uncommitted ? { uncommitted: true } : {})
    })
  }
  return result
}

function collectBlameRequests(
  projectRoot: string,
  gitRoot: string,
  diagnostics: Diagnostic[]
): Map<string, Set<number>> {
  const requests = new Map<string, Set<number>>()
  for (const diagnostic of diagnostics) {
    for (const entry of diagnostic.evidence) {
      if (!entry.file || entry.line === undefined) continue
      const file = resolveEvidenceFile(projectRoot, entry.file)
      const path = relative(gitRoot, file)
      if (!isBlameableRelativePath(path)) continue
      const lines = requests.get(file) ?? new Set<number>()
      lines.add(entry.line)
      requests.set(file, lines)
    }
  }
  return requests
}

function resolveEvidenceFile(projectRoot: string, file: string): string {
  return isAbsolute(file) ? resolve(file) : resolve(projectRoot, file)
}

export function isBlameableRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return false
  if (isAbsolute(path)) return false
  return !normalized.split('/').includes('node_modules')
}

async function resolveGitRoot(projectRoot: string, runGit: GitCommandRunner): Promise<string | undefined> {
  const cwd = runGit === executeGit ? await findGitDirectory(projectRoot) : resolve(projectRoot)
  if (!cwd) return undefined
  try {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
    return root ? resolve(root) : undefined
  } catch {
    return undefined
  }
}

async function findGitDirectory(projectRoot: string): Promise<string | undefined> {
  let current = resolve(projectRoot)
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

async function executeGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000
  })
  return stdout
}
