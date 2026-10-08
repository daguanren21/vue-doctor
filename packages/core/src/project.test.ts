import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import * as core from './index.js'

const { classifyVueFramework, createProjectInventory } = core

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-app',
    dependencies: {
      vue: '^3.5.0',
      vite: '^8.0.0',
      'example-ui': '1.2.0'
    }
  })
  await mkdir(join(root, 'node_modules/vue'), { recursive: true })
  await mkdir(join(root, 'node_modules/vite'), { recursive: true })
  await mkdir(join(root, 'node_modules/example-ui'), { recursive: true })
  await writeJson(join(root, 'node_modules/vue/package.json'), {
    name: 'vue',
    version: '3.5.39'
  })
  await writeJson(join(root, 'node_modules/vite/package.json'), {
    name: 'vite',
    version: '8.1.3'
  })
  await writeJson(join(root, 'node_modules/example-ui/package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    types: './dist/index.d.ts'
  })
  return root
}

async function createAliasProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-alias-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-alias-app',
    dependencies: {
      '@fixture/ui-alias': 'npm:@fixture/ui@1.2.3'
    }
  })
  await mkdir(join(root, 'node_modules/@fixture/ui-alias'), { recursive: true })
  await writeJson(join(root, 'node_modules/@fixture/ui-alias/package.json'), {
    name: '@fixture/ui',
    version: '1.2.3'
  })
  return root
}

async function createDeclaredOnlyProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-declared-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-declared-app',
    dependencies: {
      '@fixture/ui': '^2.0.0'
    }
  })
  return root
}

async function createDeclaredAliasProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-declared-alias-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-declared-alias-app',
    dependencies: {
      '@fixture/ui-alias': 'npm:@fixture/ui@1.2.3'
    }
  })
  return root
}

async function createVersionlessInstalledProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-versionless-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-versionless-app',
    dependencies: {
      '@fixture/ui-alias': 'workspace:*'
    }
  })
  await mkdir(join(root, 'node_modules/@fixture/ui-alias'), { recursive: true })
  await writeJson(join(root, 'node_modules/@fixture/ui-alias/package.json'), {
    name: '@fixture/ui'
  })
  return root
}

describe('project inventory', () => {
  test('prefers installed package versions over declared dependency ranges', async () => {
    const root = await createProject()

    const inventory = await createProjectInventory({ root })

    expect(inventory.root).toBe(root)
    expect(inventory.vue?.installedVersion).toBe('3.5.39')
    expect(inventory.vue?.declaredVersion).toBe('^3.5.0')
    expect(inventory.vite?.installedVersion).toBe('8.1.3')
    expect(inventory.packages['example-ui']).toMatchObject({
      dependencyName: 'example-ui',
      canonicalName: 'example-ui',
      declaredVersion: '1.2.0',
      installedVersion: '1.2.3',
      packageRoot: join(root, 'node_modules/example-ui'),
      importRoots: ['example-ui']
    })
  })

  test('preserves dependency and canonical import roots for npm aliases', async () => {
    const root = await createAliasProject()

    const inventory = await createProjectInventory({ root })

    expect(inventory.packages['@fixture/ui-alias']).toEqual({
      dependencyName: '@fixture/ui-alias',
      canonicalName: '@fixture/ui',
      declaredVersion: 'npm:@fixture/ui@1.2.3',
      installedVersion: '1.2.3',
      packageJsonPath: join(root, 'node_modules/@fixture/ui-alias/package.json'),
      packageRoot: join(root, 'node_modules/@fixture/ui-alias'),
      importRoots: ['@fixture/ui-alias', '@fixture/ui'],
      source: 'installed'
    })
  })

  test('uses the dependency key as canonical identity for declared-only packages', async () => {
    const root = await createDeclaredOnlyProject()

    const inventory = await createProjectInventory({ root })

    expect(inventory.packages['@fixture/ui']).toEqual({
      dependencyName: '@fixture/ui',
      canonicalName: '@fixture/ui',
      declaredVersion: '^2.0.0',
      importRoots: ['@fixture/ui'],
      source: 'declared'
    })
  })

  test('preserves canonical identity for declared-only npm aliases', async () => {
    const root = await createDeclaredAliasProject()

    const inventory = await createProjectInventory({ root })

    expect(inventory.packages['@fixture/ui-alias']).toEqual({
      dependencyName: '@fixture/ui-alias',
      canonicalName: '@fixture/ui',
      declaredVersion: 'npm:@fixture/ui@1.2.3',
      importRoots: ['@fixture/ui-alias', '@fixture/ui'],
      source: 'declared'
    })
  })

  test('preserves installed canonical identity when a workspace manifest has no version', async () => {
    const root = await createVersionlessInstalledProject()

    const inventory = await createProjectInventory({ root })

    expect(inventory.packages['@fixture/ui-alias']).toEqual({
      dependencyName: '@fixture/ui-alias',
      canonicalName: '@fixture/ui',
      declaredVersion: 'workspace:*',
      packageJsonPath: join(root, 'node_modules/@fixture/ui-alias/package.json'),
      packageRoot: join(root, 'node_modules/@fixture/ui-alias'),
      importRoots: ['@fixture/ui-alias', '@fixture/ui'],
      source: 'installed'
    })
  })

  test('resolves explicitly configured UI packages outside top-level dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-included-'))
    await writeJson(join(root, 'package.json'), { name: 'fixture-included-app' })
    await mkdir(join(root, 'node_modules/transitive-ui'), { recursive: true })
    await writeJson(join(root, 'node_modules/transitive-ui/package.json'), {
      name: 'transitive-ui',
      version: '2.1.0'
    })

    const inventory = await createProjectInventory({
      root,
      includePackages: ['transitive-ui']
    })

    expect(inventory.packages['transitive-ui']).toMatchObject({
      installedVersion: '2.1.0',
      source: 'installed'
    })
    expect(inventory.packages['transitive-ui']).not.toHaveProperty('declaredVersion')
  })

  test('resolves hoisted packages from the consuming workspace root even when exports hide package.json', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-doctor-core-hoisted-'))
    const root = join(workspace, 'packages/app')
    const packageRoot = join(workspace, 'node_modules/vue')
    await mkdir(root, { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeJson(join(root, 'package.json'), {
      name: 'workspace-app',
      dependencies: { vue: '^3.5.0' }
    })
    await writeJson(join(packageRoot, 'package.json'), {
      name: 'vue',
      version: '3.5.41',
      exports: { '.': './index.js' }
    })
    await writeFile(join(packageRoot, 'index.js'), 'export const version = "3.5.41"\n')

    const inventory = await createProjectInventory({ root })

    expect(inventory.vue).toMatchObject({
      dependencyName: 'vue',
      canonicalName: 'vue',
      installedVersion: '3.5.41',
      packageJsonPath: join(packageRoot, 'package.json'),
      packageRoot,
      source: 'installed'
    })
  })

  test('uses the physical manifest behind a pnpm-style alias symlink as package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-core-pnpm-'))
    const physicalRoot = join(root, 'node_modules/.pnpm/@fixture+ui@1.2.3/node_modules/@fixture/ui')
    const aliasRoot = join(root, 'node_modules/@fixture/ui-alias')
    await mkdir(physicalRoot, { recursive: true })
    await mkdir(join(root, 'node_modules/@fixture'), { recursive: true })
    await writeJson(join(root, 'package.json'), {
      dependencies: { '@fixture/ui-alias': 'npm:@fixture/ui@1.2.3' }
    })
    await writeJson(join(physicalRoot, 'package.json'), {
      name: '@fixture/ui',
      version: '1.2.3',
      exports: { '.': './index.js' }
    })
    await writeFile(join(physicalRoot, 'index.js'), 'export default {}\n')
    await symlink(physicalRoot, aliasRoot, 'dir')

    const inventory = await createProjectInventory({ root })
    const resolvedPhysicalRoot = await realpath(physicalRoot)

    expect(inventory.packages['@fixture/ui-alias']).toEqual({
      dependencyName: '@fixture/ui-alias',
      canonicalName: '@fixture/ui',
      declaredVersion: 'npm:@fixture/ui@1.2.3',
      installedVersion: '1.2.3',
      packageJsonPath: join(resolvedPhysicalRoot, 'package.json'),
      packageRoot: resolvedPhysicalRoot,
      importRoots: ['@fixture/ui-alias', '@fixture/ui'],
      source: 'installed'
    })
  })

  test('classifies only Vue 2.7 and Vue 3 as supported frameworks', () => {
    expect(classifyVueFramework('2.7.16')).toBe('vue2.7')
    expect(classifyVueFramework('^3.5.0')).toBe('vue3')
    expect(classifyVueFramework('2.6.14')).toBe('unsupported')
    expect(classifyVueFramework('4.0.0')).toBe('unsupported')
    expect(classifyVueFramework('workspace:*')).toBe('unknown')
  })

  test('does not expose a second DoctorReport producer', () => {
    expect(core).not.toHaveProperty('runDoctor')
  })
})
