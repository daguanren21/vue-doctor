import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createVueDoctorCacheKey,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache
} from './cache.js'

describe('Vue Doctor cache', () => {
  test('round-trips and removes a namespaced binary entry', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-cache-'))
    const key = createVueDoctorCacheKey(['fixture', new Uint8Array([1, 2, 3])])

    await writeVueDoctorCache('source-v1', key, new Uint8Array([4, 5, 6]), cacheDirectory)

    expect(await readVueDoctorCache('source-v1', key, cacheDirectory)).toEqual(
      Buffer.from([4, 5, 6])
    )
    await removeVueDoctorCache('source-v1', key, cacheDirectory)
    expect(await readVueDoctorCache('source-v1', key, cacheDirectory)).toBeUndefined()
  })
})
