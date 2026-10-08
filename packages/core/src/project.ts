import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { minVersion } from 'semver'
import type { SemVer } from 'semver'
import type { PackageResolution, ProjectInventory, ResolvedVueVersion, VueFramework } from './types.js'

type PackageJson = {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface CreateProjectInventoryOptions {
  root?: string
  /** Resolve additional installed packages even when they are not top-level dependencies. */
  includePackages?: string[]
}

export async function createProjectInventory(options: CreateProjectInventoryOptions = {}): Promise<ProjectInventory> {
  const root = resolve(options.root ?? process.cwd())
  const packageJsonPath = join(root, 'package.json')
  const packageJson = await readJsonIfExists<PackageJson>(packageJsonPath)
  const declaredDependencies = collectDeclaredDependencies(packageJson)
  const packageNames = new Map<string, string | undefined>(Object.entries(declaredDependencies))
  for (const packageName of options.includePackages ?? []) {
    const normalized = packageName.trim()
    if (normalized && !packageNames.has(normalized)) {
      packageNames.set(normalized, undefined)
    }
  }
  const packages: Record<string, PackageResolution> = {}

  for (const [dependencyName, declaredVersion] of packageNames) {
    packages[dependencyName] = await resolvePackage(root, dependencyName, declaredVersion)
  }

  return {
    root,
    ...(packageJson ? { packageJsonPath } : {}),
    ...(packages.vue ? { vue: packages.vue } : {}),
    ...(packages.vite ? { vite: packages.vite } : {}),
    packages
  }
}

async function resolvePackage(
  root: string,
  dependencyName: string,
  declaredVersion: string | undefined
): Promise<PackageResolution> {
  const installed = await resolveInstalledPackage(root, dependencyName, declaredVersion)

  if (installed) {
    const canonicalName = installed.manifest.name ?? dependencyName
    return {
      dependencyName,
      canonicalName,
      ...(declaredVersion ? { declaredVersion } : {}),
      ...(installed.manifest.version ? { installedVersion: installed.manifest.version } : {}),
      packageJsonPath: installed.packageJsonPath,
      packageRoot: dirname(installed.packageJsonPath),
      importRoots: [...new Set([dependencyName, canonicalName])],
      source: 'installed'
    }
  }

  const canonicalName = resolveDeclaredNpmAlias(declaredVersion) ?? dependencyName
  return {
    dependencyName,
    canonicalName,
    ...(declaredVersion ? { declaredVersion } : {}),
    importRoots: [...new Set([dependencyName, canonicalName])],
    source: 'declared'
  }
}

async function resolveInstalledPackage(
  root: string,
  dependencyName: string,
  declaredVersion: string | undefined
): Promise<{ packageJsonPath: string; manifest: PackageJson } | undefined> {
  // Resolve the dependency from the consuming package rather than assuming a local
  // node_modules directory. This covers hoisted workspace dependencies and follows
  // pnpm/npm link symlinks to the manifest that actually supplies runtime code.
  for (const packageDirectory of packageSearchDirectories(root, dependencyName)) {
    const physicalDirectory = await resolveCandidateDirectory(packageDirectory)
    if (!physicalDirectory) continue
    const packageJsonPath = join(physicalDirectory, 'package.json')
    const manifest = await readJsonIfExists<PackageJson>(packageJsonPath)
    if (manifest) return { packageJsonPath, manifest }
  }

  // Package managers without a conventional node_modules layout can still expose
  // an executable entry through Node resolution. Walk only that resolved package,
  // never the whole dependency tree, and recover its physical manifest even when
  // `exports` intentionally hides `package.json`.
  const canonicalName = resolveDeclaredNpmAlias(declaredVersion) ?? dependencyName
  try {
    const require = createRequire(join(root, 'package.json'))
    const entry = await realpath(require.resolve(dependencyName))
    if (!isInside(root, entry)) return undefined
    let directory = dirname(entry)
    const filesystemRoot = parse(directory).root
    while (directory !== filesystemRoot) {
      const packageJsonPath = join(directory, 'package.json')
      const manifest = await readJsonIfExists<PackageJson>(packageJsonPath)
      if (manifest && (!manifest.name || [dependencyName, canonicalName].includes(manifest.name))) {
        return { packageJsonPath, manifest }
      }
      directory = dirname(directory)
    }
  } catch {
    // Installed evidence is optional; declaration metadata remains the fallback.
  }
  return undefined
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function packageSearchDirectories(root: string, dependencyName: string): string[] {
  const directories: string[] = []
  let current = root
  const filesystemRoot = parse(current).root
  while (true) {
    directories.push(join(current, 'node_modules', dependencyName))
    if (current === filesystemRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

async function resolveCandidateDirectory(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path)
    return stats.isSymbolicLink() ? await realpath(path) : path
  } catch {
    return undefined
  }
}

function resolveDeclaredNpmAlias(declaredVersion: string | undefined): string | undefined {
  if (!declaredVersion?.startsWith('npm:')) {
    return undefined
  }
  const specifier = declaredVersion.slice('npm:'.length)
  const versionSeparator = specifier.lastIndexOf('@')
  const packageName = versionSeparator > 0
    ? specifier.slice(0, versionSeparator)
    : specifier
  if (!packageName || (packageName.startsWith('@') && !packageName.includes('/'))) {
    return undefined
  }
  return packageName
}

function collectDeclaredDependencies(packageJson: PackageJson | undefined): Record<string, string> {
  if (!packageJson) {
    return {}
  }

  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies
  }
}

export function resolveVueVersion(version: string | undefined): ResolvedVueVersion | undefined {
  if (!version) {
    return undefined
  }

  let parsed: SemVer | null
  try {
    parsed = minVersion(version)
  } catch {
    return undefined
  }
  return parsed
    ? { major: parsed.major, minor: parsed.minor, patch: parsed.patch }
    : undefined
}

export function classifyVueFramework(version: string | undefined): VueFramework {
  const parsed = resolveVueVersion(version)
  if (!parsed) {
    return 'unknown'
  }
  if (parsed.major === 2) {
    return parsed.minor >= 7 ? 'vue2.7' : 'unsupported'
  }
  return parsed.major === 3 ? 'vue3' : 'unsupported'
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    await access(path)
  } catch {
    return undefined
  }

  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}
