import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isUint8Array } from 'node:util/types'

const cacheIoErrorCodes: Readonly<Record<string, true>> = {
  EACCES: true, EBUSY: true, EDQUOT: true, EEXIST: true, EFBIG: true,
  EIO: true, EISDIR: true, ELOOP: true, EMFILE: true, ENAMETOOLONG: true,
  ENFILE: true, ENOENT: true, ENOSPC: true, ENOTDIR: true, ENOTEMPTY: true,
  EPERM: true, EROFS: true, ESTALE: true, ETIMEDOUT: true,
  ERR_FS_EISDIR: true
}

export function createVueDoctorCacheKey(parts: Array<string | Uint8Array>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function readVueDoctorCache(
  namespace: string,
  key: string,
  cacheDirectory?: string
): Promise<Buffer | undefined> {
  const path = cacheEntryPath(namespace, key, cacheDirectory)
  if (isVueDoctorCacheDisabled() && !cacheDirectory) return undefined
  try {
    return await readFile(path)
  } catch (error) {
    if (!isCacheIoError(error)) throw error
    return undefined
  }
}

export async function writeVueDoctorCache(
  namespace: string,
  key: string,
  value: string | Uint8Array,
  cacheDirectory?: string
): Promise<void> {
  const path = cacheEntryPath(namespace, key, cacheDirectory)
  if (typeof value !== 'string' && !isUint8Array(value)) {
    throw new TypeError('Cache value must be a string or Uint8Array.')
  }
  if (isVueDoctorCacheDisabled() && !cacheDirectory) return
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporaryPath, value)
    await rename(temporaryPath, path)
  } catch (error) {
    await removeCacheFile(temporaryPath)
    if (!isCacheIoError(error)) throw error
  }
}

export async function removeVueDoctorCache(
  namespace: string,
  key: string,
  cacheDirectory?: string
): Promise<void> {
  await removeCacheFile(cacheEntryPath(namespace, key, cacheDirectory))
}

async function removeCacheFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    if (!isCacheIoError(error)) throw error
  }
}

function isCacheIoError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && cacheIoErrorCodes[error.code] === true
}

export function isVueDoctorCacheDisabled(): boolean {
  return process.env.VUE_DOCTOR_DISABLE_CACHE === '1' || process.env.NODE_ENV === 'test'
}
function cacheEntryPath(namespace: string, key: string, cacheDirectory?: string): string {
  if (!/^[a-z0-9-]+$/.test(namespace) || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Invalid Vue Doctor cache key.')
  }
  return join(cacheDirectory ?? defaultCacheDirectory(), namespace, `${key}.cache`)
}

function defaultCacheDirectory(): string {
  if (process.env.VUE_DOCTOR_CACHE_DIR) return process.env.VUE_DOCTOR_CACHE_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'vue-doctor')
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'vue-doctor')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vue-doctor')
}
