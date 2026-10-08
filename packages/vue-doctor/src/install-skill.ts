import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectInstalledSkillAgents,
  getSkillAgentTypes,
  installSkillsFromSource,
  isSkillAgentType,
  SKILL_MANIFEST_FILE,
  type SkillAgentType,
  type SkillInstallResult
} from 'agent-install'

const DEFAULT_AGENTS: SkillAgentType[] = [
  'claude-code',
  'cursor',
  'codex',
  'opencode'
]

export interface InstallVueDoctorSkillOptions {
  cwd?: string
  agents?: string[]
  allDetected?: boolean
  global?: boolean
  force?: boolean
  skillSource?: string
}

export interface InstallVueDoctorSkillResult {
  source: string
  agents: SkillAgentType[]
  installed: SkillInstallResult['installed']
  failed: SkillInstallResult['failed']
  skipped: string[]
}

export function listSupportedSkillAgents(): SkillAgentType[] {
  return getSkillAgentTypes().filter((agent) => agent !== 'universal')
}

export async function detectAvailableSkillAgents(): Promise<SkillAgentType[]> {
  const detected = new Set(await detectInstalledSkillAgents())
  return listSupportedSkillAgents().filter((agent) => detected.has(agent))
}

export function resolveInstallAgents(options: {
  requested?: string[]
  detected: SkillAgentType[]
  allDetected?: boolean
}): { agents: SkillAgentType[]; skipped: string[] } {
  const detected = new Set(options.detected)
  const skipped: string[] = []

  if (options.requested && options.requested.length > 0) {
    const agents: SkillAgentType[] = []
    for (const raw of options.requested) {
      const agent = raw.trim().toLowerCase()
      if (!isSkillAgentType(agent) || agent === 'universal') {
        skipped.push(raw)
        continue
      }
      agents.push(agent)
    }
    return { agents: uniqueAgents(agents), skipped }
  }

  if (options.allDetected) {
    return { agents: [...options.detected], skipped }
  }

  const defaults = DEFAULT_AGENTS.filter((agent) => detected.has(agent))
  if (defaults.length > 0) {
    return { agents: defaults, skipped }
  }
  if (options.detected.length === 1) {
    return { agents: [...options.detected], skipped }
  }
  return { agents: [], skipped }
}

export async function installVueDoctorSkill(
  options: InstallVueDoctorSkillOptions = {}
): Promise<InstallVueDoctorSkillResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const source = await resolveSkillSourceDirectory(options.skillSource)
  const detected = await detectAvailableSkillAgents()
  const { agents, skipped } = resolveInstallAgents({
    requested: options.agents,
    detected,
    allDetected: options.allDetected
  })

  if (agents.length === 0) {
    return {
      source,
      agents,
      installed: [],
      failed: [],
      skipped
    }
  }

  // agent-install treats cwd as the project root for project-local installs.
  // For --global, install into each agent home by using process.cwd only as
  // a fallback and letting agent-install resolve global dirs via agent type.
  const result = await installSkillsFromSource({
    source,
    agents,
    cwd: options.global ? resolve(process.env.HOME ?? cwd) : cwd,
    mode: options.force ? 'copy' : 'copy'
  })

  return {
    source,
    agents,
    installed: result.installed,
    failed: result.failed,
    skipped
  }
}

export async function resolveSkillSourceDirectory(explicit?: string): Promise<string> {
  if (explicit) {
    const path = resolve(explicit)
    await assertSkillSource(path)
    return path
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Published package layout: dist/skills/vue-doctor
    resolve(here, 'skills/vue-doctor'),
    resolve(here, '../skills/vue-doctor'),
    // Monorepo development layout: <repo>/skills/vue-doctor
    resolve(here, '../../../skills/vue-doctor'),
    resolve(here, '../../../../skills/vue-doctor')
  ]

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, SKILL_MANIFEST_FILE))) {
      return candidate
    }
  }

  throw new Error(
    'Bundled Vue Doctor skill was not found. Ensure the package was built with skills included.'
  )
}

async function assertSkillSource(path: string): Promise<void> {
  if (!(await pathExists(join(path, SKILL_MANIFEST_FILE)))) {
    throw new Error(`Skill source is missing ${SKILL_MANIFEST_FILE}: ${path}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function uniqueAgents(agents: SkillAgentType[]): SkillAgentType[] {
  return [...new Set(agents)]
}

/**
 * Copy the repository skill tree into the package dist so published installs
 * can find it next to the CLI bundle.
 */
export async function materializeBundledSkillForTests(targetDir: string, sourceDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  await cp(sourceDir, targetDir, { recursive: true })
}
