import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoctorAnalysisSession } from '../packages/runner/dist/index.mjs'
import { defineRule, defineRules, oxcRule } from '../packages/rules/dist/index.mjs'

const count = Number(process.env.VUE_DOCTOR_SESSION_BENCH_FILES ?? 600)
assert(Number.isInteger(count) && count >= 512, 'Session benchmark requires at least 512 SFCs.')
const fixture = await mkdtemp(join(tmpdir(), 'vue-doctor-session-bench-'))
const originalEnvironment = Object.fromEntries(['VUE_DOCTOR_CACHE_DIR', 'VUE_DOCTOR_DISABLE_CACHE',
  'VUE_DOCTOR_PARALLEL_THRESHOLD', 'VUE_DOCTOR_PARALLEL_MIN_BYTES'].map(key => [key, process.env[key]]))
process.env.VUE_DOCTOR_CACHE_DIR = join(fixture, '.cache')
delete process.env.VUE_DOCTOR_DISABLE_CACHE
delete process.env.VUE_DOCTOR_PARALLEL_THRESHOLD
delete process.env.VUE_DOCTOR_PARALLEL_MIN_BYTES
const rows = []
let session

try {
  const root = join(fixture, 'project')
  const source = join(root, 'src')
  const library = join(root, 'node_modules/example-ui')
  await Promise.all([mkdir(source, { recursive: true }), mkdir(join(library, 'components'), { recursive: true }),
    mkdir(join(root, 'node_modules/vue'), { recursive: true })])
  await Promise.all([
    json(join(root, 'package.json'), { private: true, dependencies: { vue: '3.5.39', 'example-ui': '1.0.0' } }),
    json(join(root, 'node_modules/vue/package.json'), { name: 'vue', version: '3.5.39' }),
    json(join(library, 'package.json'), { name: 'example-ui', version: '1.0.0', types: './index.d.ts' }),
    writeFile(join(library, 'index.d.ts'), "export { ExampleButton } from './components/Button'\n"),
    writeFile(join(library, 'components/Button.d.ts'), "import type { ButtonProps } from './Props'\nexport declare const ExampleButton: { new(): { $props: ButtonProps } }\n"),
    writeFile(join(library, 'components/Props.d.ts'), 'export interface ButtonProps { label?: string }\n'),
    writeFile(join(source, 'main.ts'), "import { createApp } from 'vue'\nimport App from './Component0.vue'\ncreateApp(App).mount('#app')\n")
  ])
  const padding = 'fixture padding '.repeat(160)
  const contents = Array.from({ length: count }, (_, index) => `<script setup lang="ts">
import { ExampleButton } from 'example-ui'
const label = 'Button ${index}'
/* ${padding} */
</script>
<template><ExampleButton label="Button ${index}" /><button :title="label">Open</button></template>
<style scoped>.fixture { color: inherit; }</style>
`)
  assert(contents.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) >= 1_000_000)
  await Promise.all(contents.map((text, index) => writeFile(join(source, `Component${index}.vue`), text)))
  const custom = defineRules({
    name: 'benchmark',
    rules: {
      'label-declaration': defineRule({
        meta: { title: 'Fixture label declaration', description: 'Find label declarations in benchmark fixture scripts.' },
        check: oxcRule({
          create(context) {
            return {
              VariableDeclarator(node) {
                if (node.id.type === 'Identifier' && node.id.name === 'label') {
                  context.report({ node, message: 'Fixture label declaration found.' })
                }
              }
            }
          }
        })
      })
    }
  })
  const options = { root, scope: 'src', config: { gitAttribution: false, rulePacks: [custom] } }
  session = createDoctorAnalysisSession(options)
  const cold = await measure('cold: declarations + custom rules + default parallel', () => session.run())
  assert.equal(cold.diagnostics.filter(item => item.code === 'benchmark/label-declaration').length, count,
    'Custom rule must execute once for every fixture component.')
  assert.equal(session.getStats().source.workerPoolStarts, 1, 'Default parallel branch did not start a worker pool.')
  assert.equal(session.getStats().source.workerFallbacks, 0, 'Worker failed; this is not a parallel measurement.')
  const warm = await measure('warm: completed run is revalidated', () => session.run())
  assert.deepEqual(warm.diagnostics, cold.diagnostics)

  const changedFile = join(source, 'Component0.vue')
  await writeFile(changedFile, contents[0].replace('label="Button 0"', ':label="42"'))
  session.invalidate(changedFile)
  const edited = await measure('single source edit', () => session.run())
  assert(edited.diagnostics.some(item => item.code === 'component-prop-type-mismatch'))

  const beforeConcurrent = session.getStats().runsStarted
  await measure('8 concurrent requests', () => Promise.all(Array.from({ length: 8 }, () => session.run())))
  assert.equal(session.getStats().runsStarted - beforeConcurrent, 1)

  await writeFile(join(library, 'components/Props.d.ts'), 'export interface ButtonProps { label?: number }\n')
  session.invalidate(join(library, 'components/Props.d.ts'))
  const declarationEdit = await measure('transitive declaration edit', () => session.run())
  assert.equal(declarationEdit.diagnostics.filter(item => item.code === 'component-prop-type-mismatch').length, count - 1)

  const startsBefore = session.getStats().source.workerPoolStarts
  // Force an uncached serial read of the same facts to verify execution equivalence.
  process.env.VUE_DOCTOR_DISABLE_CACHE = '1'
  process.env.VUE_DOCTOR_PARALLEL_THRESHOLD = String(count + 10)
  const serialSession = createDoctorAnalysisSession(options)
  try {
    const serial = await measure('serial equivalence (fresh parser)', () => serialSession.run(), serialSession)
    assert.deepEqual(serial.diagnostics, declarationEdit.diagnostics)
  } finally { await serialSession.close() }
  assert.equal(session.getStats().source.workerPoolStarts, startsBefore)
  const stats = session.getStats()
  await session.close()
  assert.equal(session.getStats().source.factCacheEntries, 0)
  const metrics = { fileCount: count, sourceBytes: contents.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
    rows, stats, processPeakRssKiB: process.resourceUsage().maxRSS }
  console.table(rows.map(({ name, durationMs, observedRssBytes, delta }) => ({ name,
    durationMs: durationMs.toFixed(2), observedRssMiB: (observedRssBytes / 1024 / 1024).toFixed(1),
    parses: delta.parseCount, factHits: delta.factCacheHits, runs: delta.runsStarted })))
  console.log(JSON.stringify(metrics, null, 2))
  if (process.env.VUE_DOCTOR_SESSION_BENCH_JSON) await json(process.env.VUE_DOCTOR_SESSION_BENCH_JSON, metrics)
} finally {
  await session?.close()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(fixture, { recursive: true, force: true })
}

async function measure(name, run, statsSource = session) {
  const before = statsSource.getStats()
  const started = performance.now()
  let observedRssBytes = process.memoryUsage().rss
  const sampler = setInterval(() => { observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss) }, 10)
  try {
    const result = await run()
    observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss)
    const after = statsSource.getStats()
    const delta = Object.fromEntries(['runsStarted', 'runsCompleted', 'runsFailed'].map(key => [key, after[key] - before[key]]))
    for (const key of ['sourceReads', 'sourceBytes', 'factCacheHits', 'factCacheMisses', 'parseCount', 'analysisMilliseconds', 'workerPoolStarts']) {
      delta[key] = after.source[key] - before.source[key]
    }
    rows.push({ name, durationMs: performance.now() - started, observedRssBytes, delta,
      lastRun: after.lastRun })
    return result
  } finally { clearInterval(sampler) }
}

async function json(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`) }
