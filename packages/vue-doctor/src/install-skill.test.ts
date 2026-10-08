import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  installVueDoctorSkill,
  resolveInstallAgents,
  resolveSkillSourceDirectory
} from './install-skill.js'

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('install skill helpers', () => {
  test('resolves bundled skill source from monorepo layout', async () => {
    const source = await resolveSkillSourceDirectory()
    expect(await exists(join(source, 'SKILL.md'))).toBe(true)
    const content = await readFile(join(source, 'SKILL.md'), 'utf8')
    expect(content).toContain('name: vue-doctor')
  })

  test('selects default agents from detected set', () => {
    const result = resolveInstallAgents({
      detected: ['claude-code', 'goose', 'cursor'] as any
    })
    expect(result.agents).toEqual(['claude-code', 'cursor'])
  })

  test('installs skill into project-local claude skills directory', async () => {
    const project = await mkdtemp(join(tmpdir(), 'vue-doctor-install-proj-'))
    const result = await installVueDoctorSkill({
      cwd: project,
      agents: ['claude-code']
    })

    expect(result.failed).toEqual([])
    expect(result.installed.length).toBe(1)
    expect(result.installed[0]?.agent).toBe('claude-code')
    expect(result.installed[0]?.path).toContain(`${project}/.claude/skills/vue-doctor`)
    expect(await exists(join(project, '.claude/skills/vue-doctor/SKILL.md'))).toBe(true)
  })
})
