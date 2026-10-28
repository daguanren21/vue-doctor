import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { version as typeScriptVersion } from 'typescript-native'
import {
  createVueDoctorCacheKey,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache
} from '@daguanren21/vue-doctor-core'
import type { ComponentLibraryEvidence, EvidenceFile } from '../types.js'
import type {
  ComponentContractMap,
  DeclarationCacheInputs
} from './types.js'

const contractCacheNamespace = 'contracts-v2'
const contractAnalyzerVersion = '8'
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
      || !isComponentContractMap(payload.contracts)
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

function isComponentContractMap(value: unknown): value is ComponentContractMap {
  return value !== null && typeof value === 'object'
    && 'components' in value && isEntries(value.components, isComponentContract)
    && 'sources' in value && isArrayOf(value.sources, isProvenance)
    && 'problems' in value && isArrayOf(value.problems, (problem) => (
      problem !== null && typeof problem === 'object' && !Array.isArray(problem)
      && 'message' in problem && typeof problem.message === 'string'
      && (!('path' in problem) || problem.path === undefined || typeof problem.path === 'string')
    ))
}

function isComponentContract(value: unknown): boolean {
  if (value === null || typeof value !== 'object'
    || !('fallthrough' in value) || value.fallthrough === null || typeof value.fallthrough !== 'object') return false
  const fallthrough = value.fallthrough
  return 'name' in value && typeof value.name === 'string'
    && 'aliases' in value && isStringArray(value.aliases)
    && 'props' in value && isDimension(value.props, isPropContract)
    && 'events' in value && isDimension(value.events, isEventContract)
    && 'slots' in value && isDimension(value.slots, (slot) => (
      slot !== null && typeof slot === 'object' && 'name' in slot && typeof slot.name === 'string'
    ))
    && 'attributes' in fallthrough && isAcceptance(fallthrough.attributes)
    && 'listeners' in fallthrough && isAcceptance(fallthrough.listeners)
    && (!('attributeTargets' in fallthrough) || fallthrough.attributeTargets === undefined || isArrayOf(fallthrough.attributeTargets, (target) => (
      target !== null && typeof target === 'object' && !Array.isArray(target)
      && 'kind' in target && (target.kind === 'component' || target.kind === 'element')
      && 'name' in target && typeof target.name === 'string'
      && 'file' in target && typeof target.file === 'string'
      && (!('excludedAttributes' in target) || target.excludedAttributes === undefined || isStringArray(target.excludedAttributes))
      && (!('supportedAttributes' in target) || target.supportedAttributes === undefined || isStringArray(target.supportedAttributes))
    )))
    && (!('vue2Model' in value) || value.vue2Model === undefined || value.vue2Model === null || (
      typeof value.vue2Model === 'object'
      && 'prop' in value.vue2Model && typeof value.vue2Model.prop === 'string'
      && 'event' in value.vue2Model && typeof value.vue2Model.event === 'string'
    ))
    && 'sources' in value && isArrayOf(value.sources, isProvenance)
}

function isDimension(value: unknown, isEntry: (value: unknown) => boolean): boolean {
  return value !== null && typeof value === 'object'
    && 'knowledge' in value && (value.knowledge === 'known' || value.knowledge === 'partial' || value.knowledge === 'unknown')
    && 'acceptance' in value && isAcceptance(value.acceptance)
    && 'entries' in value && isEntries(value.entries, isEntry)
    && 'issues' in value && isArrayOf(value.issues, (issue) => (
      issue !== null && typeof issue === 'object' && !Array.isArray(issue)
      && 'code' in issue && typeof issue.code === 'string'
      && 'message' in issue && typeof issue.message === 'string'
      && (!('artifact' in issue) || issue.artifact === undefined || typeof issue.artifact === 'string')
    ))
}

function isEntries(value: unknown, isEntry: (value: unknown) => boolean): boolean {
  if (!(value instanceof Map)) return false
  for (const [key, entry] of value) {
    if (typeof key !== 'string' || !isEntry(entry)) return false
  }
  return true
}

function isPropContract(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && 'name' in value && typeof value.name === 'string'
    && (!('required' in value) || value.required === undefined || typeof value.required === 'boolean')
    && (!('types' in value) || value.types === undefined || isArrayOf(value.types, isPropType))
}

function isPropType(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return false
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
    case 'function':
    case 'symbol':
    case 'bigint':
    case 'any':
    case 'unknown':
    case 'null':
      return !('value' in value) || value.value === undefined
        || typeof value.value === 'string'
        || typeof value.value === 'number'
        || typeof value.value === 'boolean'
    case 'literal':
      return 'value' in value && (typeof value.value === 'string'
        || typeof value.value === 'boolean'
        || (typeof value.value === 'number' && Number.isFinite(value.value)))
    default:
      return false
  }
}

function isEventContract(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && 'name' in value && typeof value.name === 'string'
    && 'source' in value && (value.source === 'emit' || value.source === 'listener-prop' || value.source === 'metadata')
    && 'signatures' in value && isArrayOf(value.signatures, (signature) => (
      signature !== null && typeof signature === 'object' && !Array.isArray(signature)
      && 'minArity' in signature && typeof signature.minArity === 'number'
      && Number.isInteger(signature.minArity) && signature.minArity >= 0
      && 'maxArity' in signature && (signature.maxArity === null || (
        typeof signature.maxArity === 'number' && Number.isInteger(signature.maxArity) && signature.maxArity >= 0
      ))
      && 'parameters' in signature && isArrayOf(signature.parameters, (parameter) => (
        parameter !== null && typeof parameter === 'object' && !Array.isArray(parameter)
        && (!('name' in parameter) || parameter.name === undefined || typeof parameter.name === 'string')
        && 'optional' in parameter && typeof parameter.optional === 'boolean'
        && 'rest' in parameter && typeof parameter.rest === 'boolean'
      ))
    ))
}

function isProvenance(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && 'source' in value && (value.source === 'adapter' || value.source === 'web-types' || value.source === 'vetur-tags'
      || value.source === 'vetur-attributes' || value.source === 'typescript' || value.source === 'runtime')
    && 'path' in value && typeof value.path === 'string'
    && 'relativePath' in value && typeof value.relativePath === 'string'
}

function isArrayOf(value: unknown, isItem: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !isItem(value[index])) return false
  }
  return true
}

function isStringArray(value: unknown): value is string[] {
  return isArrayOf(value, (item) => typeof item === 'string')
}

function isAcceptance(value: unknown): value is 'closed' | 'open' | 'unknown' {
  return value === 'closed' || value === 'open' || value === 'unknown'
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
