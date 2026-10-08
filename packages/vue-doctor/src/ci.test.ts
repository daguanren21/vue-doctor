import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { installGithubActionsWorkflow } from './ci.js'

describe('ci install', () => {
  test('preserves an edited workflow unless replacement is explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-ci-'))
    try {
      const first = await installGithubActionsWorkflow({ root, failOn: 'error', changed: true })
      expect(first.status).toBe('created')
      const generated = await readFile(first.workflowPath, 'utf8')
      const customized = `${generated}\n# Project customization\n`
      await writeFile(first.workflowPath, customized)

      const second = await installGithubActionsWorkflow({ root })
      expect(second.status).toBe('exists')
      expect(await readFile(first.workflowPath, 'utf8')).toBe(customized)

      const replacement = await installGithubActionsWorkflow({ root, force: true, failOn: 'error', changed: true })
      expect(replacement.status).toBe('created')
      expect(await readFile(first.workflowPath, 'utf8')).toBe(generated)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
