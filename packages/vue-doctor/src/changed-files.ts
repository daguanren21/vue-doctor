import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type ChangedFilesBase = 'auto' | 'HEAD' | string

export interface ResolveChangedFilesOptions {
  root: string
  base?: ChangedFilesBase
  /** Optional explicit git binary for tests. */
  gitBinary?: string
}

export interface ResolveChangedFilesResult {
  files: string[]
  base: string
  mode: 'diff' | 'working-tree'
  repositoryRoot: string
}

/** Resolve changed paths in the containing repository, then map them into the consuming project. */
export function resolveChangedFiles(options: ResolveChangedFilesOptions): ResolveChangedFilesResult {
  const projectRoot = resolve(options.root)
  const gitBinary = options.gitBinary ?? 'git'
  const repositoryRoot = resolveRepositoryRoot(projectRoot, gitBinary)
  const base = resolveGitBase(repositoryRoot, options.base ?? 'auto', gitBinary)
  const repoPaths = base.mode === 'working-tree'
    ? parsePorcelainPaths(runGit(repositoryRoot, gitBinary, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all'
      ]))
    : splitNul(runGit(repositoryRoot, gitBinary, [
        'diff', '--name-only', '-z', '--diff-filter=ACMR', base.ref
      ]))
  const files = repoPaths
    .map((file) => normalizeRepoPath(repositoryRoot, projectRoot, file))
    .filter((file): file is string => file !== undefined)

  return {
    files: [...new Set(files)].sort(compareText),
    base: base.mode === 'working-tree' ? 'HEAD' : base.ref,
    mode: base.mode,
    repositoryRoot
  }
}

/** Intersect changed files with a valid project scope while preserving invalid scopes for discovery. */
export function intersectChangedFilesWithScope(
  root: string,
  files: readonly string[],
  scope: string
): string[] {
  const projectRoot = resolve(root)
  const scopePath = isAbsolute(scope) ? resolve(scope) : resolve(projectRoot, scope)
  if (!isInsideRoot(projectRoot, scopePath)) return [scope]
  if (hasIgnoredSegment(projectRoot, scopePath)) return [scope]

  try {
    const physicalRoot = realpathSync(projectRoot)
    const physicalScope = realpathSync(scopePath)
    if (!isInsideRoot(physicalRoot, physicalScope)) return [scope]
    const stats = statSync(physicalScope)
    accessSync(physicalScope, constants.R_OK)
    return files.filter((file) => stats.isDirectory()
      ? isInsideRoot(scopePath, file)
      : resolve(file) === scopePath)
  } catch {
    return [scope]
  }
}

function hasIgnoredSegment(root: string, path: string): boolean {
  const ignored = new Set(['node_modules', 'dist', '.git', '.worktrees', '.nuxt', '.output', 'coverage'])
  return relative(resolve(root), resolve(path)).split(/[\\/]/).some((part) => ignored.has(part))
}

function resolveRepositoryRoot(projectRoot: string, gitBinary: string): string {
  const output = runGit(projectRoot, gitBinary, ['rev-parse', '--show-toplevel'])
  const root = stripSingleLineEnding(output)
  if (!root) throw new Error('git rev-parse --show-toplevel returned an empty path')
  const physicalProjectRoot = realpathSync(projectRoot)
  const physicalRepositoryRoot = realpathSync(resolve(root))
  if (!isInsideRoot(physicalRepositoryRoot, physicalProjectRoot)) {
    throw new Error('Git repository root does not contain the consuming project')
  }
  // Preserve the caller's lexical path spelling (/var vs /private/var, symlinked workspaces, etc.).
  return resolve(projectRoot, relative(physicalProjectRoot, physicalRepositoryRoot))
}

function resolveGitBase(
  root: string,
  requested: ChangedFilesBase,
  gitBinary: string
): { mode: 'diff'; ref: string } | { mode: 'working-tree' } {
  if (requested === 'HEAD') return { mode: 'working-tree' }
  if (requested !== 'auto') return { mode: 'diff', ref: requested }

  const baseRef = process.env.GITHUB_BASE_REF?.trim()
  if (baseRef) {
    const candidates = [`origin/${baseRef}`, baseRef, `refs/remotes/origin/${baseRef}`]
    for (const candidate of candidates) {
      if (gitRefExists(root, gitBinary, candidate)) {
        return { mode: 'diff', ref: `${candidate}...HEAD` }
      }
    }
  }

  // Local and push callers must choose an explicit comparison when they do not want working-tree mode.
  return { mode: 'working-tree' }
}

function gitRefExists(root: string, gitBinary: string, ref: string): boolean {
  try {
    runGit(root, gitBinary, ['rev-parse', '--verify', ref])
    return true
  } catch {
    return false
  }
}

function runGit(root: string, gitBinary: string, args: string[]): string {
  const result = spawnSync(gitBinary, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`)
  }
  return result.stdout ?? ''
}

function parsePorcelainPaths(output: string): string[] {
  const tokens = splitNul(output)
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return paths
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0)
}

function normalizeRepoPath(
  repositoryRoot: string,
  projectRoot: string,
  file: string
): string | undefined {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(repositoryRoot, file)
  if (!isInsideRoot(repositoryRoot, absolute) || !isInsideRoot(projectRoot, absolute)) return undefined
  if (!existsSync(absolute)) return undefined
  return absolute
}

function isInsideRoot(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path))
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function stripSingleLineEnding(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
