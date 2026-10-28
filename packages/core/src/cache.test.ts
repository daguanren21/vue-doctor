import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createVueDoctorCacheKey,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache
} from './cache.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createCacheDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'vue-doctor-cache-'))
  directories.push(directory)
  return directory
}

describe('Vue Doctor cache', () => {
  test('round-trips and removes a namespaced binary entry', async () => {
    const cacheDirectory = await createCacheDirectory()
    const key = createVueDoctorCacheKey(['fixture', new Uint8Array([1, 2, 3])])

    await writeVueDoctorCache('source-v1', key, new Uint8Array([4, 5, 6]), cacheDirectory)

    expect(await readVueDoctorCache('source-v1', key, cacheDirectory)).toEqual(
      Buffer.from([4, 5, 6])
    )
    await removeVueDoctorCache('source-v1', key, cacheDirectory)
    expect(await readVueDoctorCache('source-v1', key, cacheDirectory)).toBeUndefined()
  })

  test('accepts Uint8Array data from another JavaScript realm', async () => {
    const cacheDirectory = await createCacheDirectory()
    const key = createVueDoctorCacheKey(['cross-realm'])
    const bytes: Uint8Array = runInNewContext('new Uint8Array([7, 8, 9])')

    await writeVueDoctorCache('source-v1', key, bytes, cacheDirectory)

    expect(await readVueDoctorCache('source-v1', key, cacheDirectory)).toEqual(Buffer.from([7, 8, 9]))
  })

  test('treats a non-directory cache root as best-effort storage', async () => {
    const root = await createCacheDirectory()
    const cacheDirectory = join(root, 'ordinary-file')
    const key = createVueDoctorCacheKey(['not-a-directory'])
    await writeFile(cacheDirectory, 'not a directory')

    await expect(readVueDoctorCache('source-v1', key, cacheDirectory)).resolves.toBeUndefined()
    await expect(writeVueDoctorCache('source-v1', key, 'analysis', cacheDirectory)).resolves.toBeUndefined()
    await expect(removeVueDoctorCache('source-v1', key, cacheDirectory)).resolves.toBeUndefined()
  })

  test('removes temporary files after a failed cache rename without deleting the conflicting directory', async () => {
    const cacheDirectory = await createCacheDirectory()
    const key = createVueDoctorCacheKey(['conflicting-directory'])
    const namespaceDirectory = join(cacheDirectory, 'source-v1')
    const entryName = `${key}.cache`
    await mkdir(join(namespaceDirectory, entryName), { recursive: true })

    await expect(writeVueDoctorCache('source-v1', key, 'analysis', cacheDirectory)).resolves.toBeUndefined()
    expect(await readdir(namespaceDirectory)).toEqual([entryName])
    await expect(readVueDoctorCache('source-v1', key, cacheDirectory)).resolves.toBeUndefined()
    await expect(removeVueDoctorCache('source-v1', key, cacheDirectory)).resolves.toBeUndefined()
    expect(await readdir(namespaceDirectory)).toEqual([entryName])
  })

  test('does not swallow invalid cache write arguments as filesystem failures', async () => {
    const cacheDirectory = await createCacheDirectory()
    const key = createVueDoctorCacheKey(['invalid-value'])

    await expect(Reflect.apply(writeVueDoctorCache, undefined, ['source-v1', key, null, cacheDirectory]))
      .rejects.toThrow(TypeError)
    expect(await readdir(cacheDirectory)).toEqual([])
  })

  test('rejects invalid cache values before unavailable or disabled storage gates', async () => {
    const root = await createCacheDirectory()
    const blocked = join(root, 'ordinary-file')
    await writeFile(blocked, 'not a directory')
    const key = createVueDoctorCacheKey(['invalid-value-without-storage'])
    const previous = process.env.VUE_DOCTOR_DISABLE_CACHE
    process.env.VUE_DOCTOR_DISABLE_CACHE = '1'
    try {
      for (const cacheDirectory of [blocked, undefined]) {
        await expect(Reflect.apply(writeVueDoctorCache, undefined, ['source-v1', key, null, cacheDirectory]))
          .rejects.toThrow(TypeError)
      }
    } finally {
      if (previous === undefined) delete process.env.VUE_DOCTOR_DISABLE_CACHE
      else process.env.VUE_DOCTOR_DISABLE_CACHE = previous
    }
  })

  test.each([
    ['namespace', '../outside', createVueDoctorCacheKey(['valid-key'])],
    ['key', 'source-v1', 'not-a-cache-key']
  ])('rejects an invalid %s even when cache storage is unavailable or disabled', async (_name, namespace, key) => {
    const root = await createCacheDirectory()
    const blocked = join(root, 'ordinary-file')
    await writeFile(blocked, 'not a directory')

    for (const cacheDirectory of [blocked, undefined]) {
      await expect(readVueDoctorCache(namespace, key, cacheDirectory)).rejects.toThrow(Error)
      await expect(writeVueDoctorCache(namespace, key, 'analysis', cacheDirectory)).rejects.toThrow(Error)
      await expect(removeVueDoctorCache(namespace, key, cacheDirectory)).rejects.toThrow(Error)
    }
  })
})
