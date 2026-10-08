import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  SourceDiscoveryIssue,
  SourceDiscoveryIssueKind,
  SourceDiscoveryResult
} from './types.js'

const ignoredDirectories = new Set(['node_modules', 'dist', '.git', '.worktrees', '.nuxt', '.output', 'coverage'])
const sourceExtensions = new Set(['.vue', '.js', '.mjs', '.cjs', '.ts', '.tsx'])

export async function listSourceFiles(root: string, scope?: string | string[], extensions: readonly string[] = []): Promise<string[]> {
  return (await discoverSourceFiles(root, scope, extensions)).files
}

export async function discoverSourceFiles(
  root: string,
  scope?: string | string[],
  extensions: readonly string[] = [],
  files?: readonly string[]
): Promise<SourceDiscoveryResult> {
  const normalizedRoot = resolve(root)
  const acceptedExtensions = new Set([...sourceExtensions, ...extensions])
  const discoveredFiles: string[] = []
  const issues: SourceDiscoveryIssue[] = []
  const entries = await resolveScanEntries(normalizedRoot, scope, acceptedExtensions, issues)
  if (files !== undefined) {
    return {
      files: await resolveAllowedFiles(normalizedRoot, entries, files, acceptedExtensions, issues),
      issues: deduplicateIssues(issues)
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'file') {
      discoveredFiles.push(entry.path)
      continue
    }

    await walk(entry.path, discoveredFiles, acceptedExtensions, issues)
  }

  return {
    files: [...new Set(discoveredFiles)].sort(compareText),
    issues: deduplicateIssues(issues)
  }
}

async function resolveAllowedFiles(
  root: string,
  scopeEntries: Array<{ kind: 'directory' | 'file'; path: string }>,
  allowlist: readonly string[],
  extensions: ReadonlySet<string>,
  issues: SourceDiscoveryIssue[]
): Promise<string[]> {
  if (allowlist.length === 0 || issues.some((issue) => issue.kind === 'root-unavailable')) return []
  let physicalRoot: string
  try {
    physicalRoot = await realpath(root)
  } catch (error) {
    issues.push(createIssue('root-unavailable', root, error))
    return []
  }
  const files: string[] = []

  for (const item of allowlist) {
    const path = isAbsolute(item) ? resolve(item) : resolve(root, item)
    if (!isInsideRoot(root, path)) {
      issues.push(createIssue('scope-outside-root', path, undefined, 'Requested source file is outside the project root.'))
      continue
    }
    if (!isInsideAnyScope(path, scopeEntries)) continue
    if (isIgnoredPath(root, path)) {
      issues.push(createIssue('scope-ignored', path, undefined, 'Requested source file is excluded from scanning.'))
      continue
    }

    let stats
    try {
      const physicalPath = await realpath(path)
      if (!isInsideRoot(physicalRoot, physicalPath)) {
        issues.push(createIssue('scope-outside-root', path, undefined, 'Requested source file is outside the project root.'))
        continue
      }
      if (isIgnoredPath(physicalRoot, physicalPath)) {
        issues.push(createIssue('scope-ignored', path, undefined, 'Requested source file is excluded from scanning.'))
        continue
      }
      stats = await stat(physicalPath)
      if (stats.isFile()) await access(physicalPath, constants.R_OK)
    } catch (error) {
      const kind = classifyScopeError(error)
      issues.push(createIssue(
        kind,
        path,
        error,
        kind === 'scope-not-found'
          ? 'Requested source file does not exist.'
          : 'Requested source file could not be read.'
      ))
      continue
    }

    if (stats.isDirectory()) {
      issues.push(createIssue(
        'scope-unreadable',
        path,
        undefined,
        'Requested file allowlist entry is a directory; only exact files are accepted.'
      ))
      continue
    }
    if (stats.isFile() && isSourceFile(path, extensions)) files.push(path)
  }

  return [...new Set(files)].sort(compareText)
}

function isInsideAnyScope(
  path: string,
  entries: Array<{ kind: 'directory' | 'file'; path: string }>
): boolean {
  return entries.some((entry) => entry.kind === 'file'
    ? resolve(entry.path) === resolve(path)
    : isInsideRoot(entry.path, path))
}

async function walk(
  directory: string,
  files: string[],
  extensions: ReadonlySet<string>,
  issues: SourceDiscoveryIssue[]
) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    issues.push(createIssue('directory-unreadable', directory, error))
    return
  }

  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walk(path, files, extensions, issues)
      }
      continue
    }

    if (entry.isFile() && isSourceFile(path, extensions)) {
      files.push(path)
    }
  }
}

async function resolveScanEntries(
  root: string,
  scope: string | string[] | undefined,
  extensions: ReadonlySet<string>,
  issues: SourceDiscoveryIssue[]
): Promise<Array<{ kind: 'directory' | 'file'; path: string }>> {
  const scopes = scope === undefined ? ['.'] : Array.isArray(scope) ? scope : [scope]
  let physicalRoot: string
  try {
    physicalRoot = await realpath(root)
  } catch (error) {
    issues.push(createIssue('root-unavailable', root, error))
    return []
  }
  const entries: Array<{ kind: 'directory' | 'file'; path: string }> = []

  for (const item of scopes) {
    const path = isAbsolute(item) ? resolve(item) : resolve(root, item)
    if (!isInsideRoot(root, path)) {
      issues.push(createIssue('scope-outside-root', path))
      continue
    }
    if (isIgnoredPath(root, path)) {
      issues.push(createIssue('scope-ignored', path))
      continue
    }

    let stats
    try {
      const physicalPath = await realpath(path)
      if (!isInsideRoot(physicalRoot, physicalPath)) {
        issues.push(createIssue('scope-outside-root', path))
        continue
      }
      if (isIgnoredPath(physicalRoot, physicalPath)) {
        issues.push(createIssue('scope-ignored', path))
        continue
      }
      stats = await stat(physicalPath)
      await access(
        physicalPath,
        stats.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK
      )
    } catch (error) {
      issues.push(createIssue(classifyScopeError(error), path, error))
      continue
    }

    if (stats.isDirectory()) {
      entries.push({ kind: 'directory' as const, path })
    }

    if (stats.isFile() && isSourceFile(path, extensions)) {
      entries.push({ kind: 'file' as const, path })
    }
  }

  return entries
}

function isSourceFile(path: string, extensions: ReadonlySet<string>) {
  return extensions.has(extname(path))
}

function isIgnoredPath(root: string, path: string) {
  return relative(resolve(root), resolve(path))
    .split(/[\\/]/)
    .some((part) => ignoredDirectories.has(part))
}

function isInsideRoot(root: string, path: string) {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  const pathFromRoot = relative(normalizedRoot, normalizedPath)

  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function classifyScopeError(error: unknown): SourceDiscoveryIssueKind {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'scope-not-found'
  if (code === 'EACCES' || code === 'EPERM') return 'scope-unreadable'
  return 'scope-unreadable'
}

function createIssue(
  kind: SourceDiscoveryIssueKind,
  path: string,
  error?: unknown,
  descriptionOverride?: string
): SourceDiscoveryIssue {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const description = descriptionOverride ?? (kind === 'root-unavailable'
    ? 'Source root is unavailable.'
    : kind === 'scope-not-found'
      ? 'Requested source scope does not exist.'
      : kind === 'scope-outside-root'
        ? 'Requested source scope is outside the project root.'
        : kind === 'scope-ignored'
          ? 'Requested source scope is excluded from scanning.'
          : kind === 'directory-unreadable'
            ? 'Source directory could not be read.'
            : 'Requested source scope could not be read.')
  return {
    kind,
    path: resolve(path),
    message: code ? `${description} (${code})` : description
  }
}

function deduplicateIssues(issues: SourceDiscoveryIssue[]): SourceDiscoveryIssue[] {
  const unique = new Map<string, SourceDiscoveryIssue>()
  for (const issue of issues) unique.set(`${issue.kind}\0${issue.path}\0${issue.message}`, issue)
  return [...unique.values()].sort((left, right) => (
    compareText(left.path, right.path)
    || compareText(left.kind, right.kind)
    || compareText(left.message, right.message)
  ))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
