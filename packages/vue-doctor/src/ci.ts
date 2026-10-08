import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface CiInstallOptions {
  root?: string
  force?: boolean
  failOn?: 'error' | 'warning' | 'info' | 'never'
  failOnIncompleteCoverage?: boolean
  changed?: boolean
}

export interface CiInstallResult {
  status: 'created' | 'exists'
  workflowPath: string
}

export async function installGithubActionsWorkflow(
  options: CiInstallOptions = {}
): Promise<CiInstallResult> {
  const root = resolve(options.root ?? process.cwd())
  const workflowPath = join(root, '.github/workflows/vue-doctor.yml')
  const exists = await pathExists(workflowPath)

  if (exists && !options.force) {
    return { status: 'exists', workflowPath }
  }

  await mkdir(dirname(workflowPath), { recursive: true })
  await writeFile(workflowPath, buildVueDoctorWorkflow({
    failOn: options.failOn ?? 'error',
    failOnIncompleteCoverage: options.failOnIncompleteCoverage ?? true,
    changed: options.changed ?? true
  }), 'utf8')

  return { status: 'created', workflowPath }
}

export function buildVueDoctorWorkflow(options: {
  failOn: 'error' | 'warning' | 'info' | 'never'
  failOnIncompleteCoverage: boolean
  changed: boolean
}): string {
  const failOn = options.failOn
  const incomplete = options.failOnIncompleteCoverage
  const changed = options.changed

  const doctorCommand = [
    'vue-doctor',
    '--json',
    failOn !== 'never' ? `--fail-on ${failOn}` : '',
    incomplete ? '--fail-on-incomplete-coverage' : ''
  ].filter(Boolean).join(' ')
  const localCommand = (suffix = '') => `|
          if [ -f yarn.lock ] && [ ! -f pnpm-lock.yaml ] && [ ! -f package-lock.json ]; then
            yarn exec ${doctorCommand}${suffix}
          else
            ./node_modules/.bin/${doctorCommand}${suffix}
          fi`
  const doctorSteps = changed
    ? `      - name: Run Vue Doctor (pull request changes)
        if: github.event_name == 'pull_request'
        run: ${localCommand(' --changed --changed-base "${{ github.event.pull_request.base.sha }}...HEAD"')}

      - name: Run Vue Doctor (push)
        if: github.event_name == 'push'
        run: ${localCommand()}`
    : `      - name: Run Vue Doctor
        run: ${localCommand()}`

  return `# Vue Doctor — diagnostics for Vue / Vite projects from installed package evidence.
#
# Requires this project's trusted Vue Doctor dependency; never downloads an unpinned CLI.
# Local: ./node_modules/.bin/vue-doctor --inspect

name: Vue Doctor

on:
  pull_request:
  push:
    branches: [main, master]

permissions:
  contents: read

concurrency:
  group: vue-doctor-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  vue-doctor:
    name: Vue Doctor
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # Needed for --changed against the PR base.
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Enable corepack
        run: corepack enable

      - name: Install dependencies
        run: |
          if [ -f pnpm-lock.yaml ]; then
            pnpm install --frozen-lockfile
          elif [ -f package-lock.json ]; then
            npm ci
          elif [ -f yarn.lock ]; then
            yarn install --frozen-lockfile
          else
            npm install
          fi

${doctorSteps}
`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
