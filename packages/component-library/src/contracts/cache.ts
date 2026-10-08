import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { version as typeScriptVersion } from 'typescript'
import {
  createVueDoctorCacheKey,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache
} from '@vue-doctor/core'
import type { ComponentLibraryEvidence, EvidenceFile } from '../types.js'
import type {
  ComponentContractMap,
  DeclarationCacheInputs
} from './types.js'

const contractCacheNamespace = 'contracts-v2'
const contractAnalyzerVersion = '6'
const contractCacheFormat = 2
const maxManifestDependencies = 4096

interface ContractCacheDependency {
  kind: 'file' | 'directory'
  path: string
  fingerprint: string
}

interface ContractCacheManifest {
  dependencies: ContractCacheDependency[]
  resolutionFingerprint: string
}

interface ContractCachePayload {
  format: number
  manifest: ContractCacheManifest
  contracts: ComponentContractMap
}

export async function createContractCacheKey(
  evidence: ComponentLibraryEvidence
): Promise<string | undefined> {
  if (
    evidence.cache !== true
    || evidence.runtime !== false
    || !evidence.package.installedVersion
    || !evidence.package.packageRoot
    || !evidence.package.packageJsonPath
    || isLocalVersion(evidence.package.declaredVersion)
  ) {
    return undefined
  }

  const packageIdentity = await readReliablePackageIdentity(evidence)
  if (!packageIdentity) return undefined

  const files = uniqueEvidenceFiles(evidence)
  if (files.length === 0) return undefined
  const parts: Array<string | Uint8Array> = [
    contractAnalyzerVersion,
    typeScriptVersion,
    process.versions.v8.split('.')[0] ?? '',
    packageIdentity,
    evidence.package.dependencyName,
    evidence.package.canonicalName,
    evidence.package.declaredVersion ?? '',
    evidence.package.installedVersion,
    [...evidence.package.importRoots].sort().join('\0')
  ]
  try {
    for (const file of files) {
      parts.push(file.path, await readFile(file.path))
    }
  } catch {
    return undefined
  }
  return createVueDoctorCacheKey(parts)
}

export async function readContractCache(
  key: string,
  cacheDirectory: string | undefined
): Promise<ComponentContractMap | undefined> {
  const cached = await readVueDoctorCache(contractCacheNamespace, key, cacheDirectory)
  if (!cached) return undefined
  try {
    const payload = deserialize(cached) as ContractCachePayload
    if (
      payload?.format !== contractCacheFormat
      || !payload.manifest
      || !Array.isArray(payload.manifest.dependencies)
      || !await validateManifest(payload.manifest)
    ) {
      await removeVueDoctorCache(contractCacheNamespace, key, cacheDirectory)
      return undefined
    }
    return payload.contracts
  } catch {
    await removeVueDoctorCache(contractCacheNamespace, key, cacheDirectory)
    return undefined
  }
}

export async function writeContractCache(
  key: string,
  contracts: ComponentContractMap,
  cacheInputs: DeclarationCacheInputs,
  cacheDirectory: string | undefined
): Promise<void> {
  const manifest = await createManifest(cacheInputs)
  if (!manifest) return
  const payload: ContractCachePayload = {
    format: contractCacheFormat,
    manifest,
    contracts
  }
  await writeVueDoctorCache(
    contractCacheNamespace,
    key,
    serialize(payload),
    cacheDirectory
  )
}

async function readReliablePackageIdentity(
  evidence: ComponentLibraryEvidence
): Promise<string | undefined> {
  const packageRoot = evidence.package.packageRoot!
  const packageJsonPath = evidence.package.packageJsonPath!
  try {
    const [rootStat, resolvedRoot, resolvedPackageJson] = await Promise.all([
      lstat(packageRoot),
      realpath(packageRoot),
      realpath(packageJsonPath)
    ])
    if (relative(resolvedRoot, resolvedPackageJson).startsWith(`..${sep}`)) return undefined
    if (rootStat.isSymbolicLink() && !resolvedRoot.includes(`${sep}node_modules${sep}.pnpm${sep}`)) {
      return undefined
    }
    return `${resolvedRoot}\0${resolvedPackageJson}`
  } catch {
    return undefined
  }
}

function isLocalVersion(version: string | undefined): boolean {
  return Boolean(version && /^(?:workspace|file|link|portal):/.test(version))
}

async function createManifest(
  inputs: DeclarationCacheInputs
): Promise<ContractCacheManifest | undefined> {
  if (!inputs.reliable) return undefined
  const files = [...new Set([...inputs.files, ...inputs.fileProbes])]
    .sort((left, right) => left.localeCompare(right))
  const directories = [...new Set(inputs.directoryProbes)]
    .sort((left, right) => left.localeCompare(right))
  if (files.length + directories.length > maxManifestDependencies) return undefined

  const dependencies: ContractCacheDependency[] = []
  for (const path of files) {
    const fingerprint = await fingerprintFile(path)
    if (!fingerprint) return undefined
    dependencies.push({ kind: 'file', path, fingerprint })
  }
  for (const path of directories) {
    const fingerprint = await fingerprintDirectory(path)
    if (!fingerprint) return undefined
    dependencies.push({ kind: 'directory', path, fingerprint })
  }

  return {
    dependencies,
    resolutionFingerprint: createVueDoctorCacheKey([
      'declaration-resolution-v1',
      ...inputs.resolutions
    ])
  }
}

async function validateManifest(manifest: ContractCacheManifest): Promise<boolean> {
  if (typeof manifest.resolutionFingerprint !== 'string') return false
  for (const dependency of manifest.dependencies) {
    if (!dependency || typeof dependency.path !== 'string' || typeof dependency.fingerprint !== 'string') {
      return false
    }
    const current = dependency.kind === 'file'
      ? await fingerprintFile(dependency.path)
      : dependency.kind === 'directory'
        ? await fingerprintDirectory(dependency.path)
        : undefined
    if (!current || current !== dependency.fingerprint) return false
  }
  return true
}

async function fingerprintFile(path: string): Promise<string | undefined> {
  try {
    return createVueDoctorCacheKey(['file', await readFile(path)])
  } catch (error) {
    return isMissingFileSystemEntry(error) ? 'missing' : undefined
  }
}

async function fingerprintDirectory(path: string): Promise<string | undefined> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return createVueDoctorCacheKey([
      'directory',
      ...entries
        .map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`)
        .sort((left, right) => left.localeCompare(right))
    ])
  } catch (error) {
    return isMissingFileSystemEntry(error) ? 'missing' : undefined
  }
}

function isMissingFileSystemEntry(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function uniqueEvidenceFiles(evidence: ComponentLibraryEvidence): EvidenceFile[] {
  const files = [
    ...(evidence.package.packageJsonPath
      ? [{
          path: evidence.package.packageJsonPath,
          relativePath: 'package.json',
          source: 'package-json' as const
        }]
      : []),
    ...evidence.artifacts.declarationEntries,
    ...(evidence.artifacts.webTypes ? [evidence.artifacts.webTypes] : []),
    ...(evidence.artifacts.veturTags ? [evidence.artifacts.veturTags] : []),
    ...(evidence.artifacts.veturAttributes ? [evidence.artifacts.veturAttributes] : [])
  ]
  return [...new Map(files.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path))
}
