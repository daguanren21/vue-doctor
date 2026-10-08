import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
  if (isVueDoctorCacheDisabled() && !cacheDirectory) return undefined
  try {
    return await readFile(cacheEntryPath(namespace, key, cacheDirectory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeVueDoctorCache(
  namespace: string,
  key: string,
  value: string | Uint8Array,
  cacheDirectory?: string
): Promise<void> {
  if (isVueDoctorCacheDisabled() && !cacheDirectory) return
  const path = cacheEntryPath(namespace, key, cacheDirectory)
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, value)
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export async function removeVueDoctorCache(
  namespace: string,
  key: string,
  cacheDirectory?: string
): Promise<void> {
  await rm(cacheEntryPath(namespace, key, cacheDirectory), { force: true })
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
