import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Bench } from 'tinybench'
import { runDoctor } from '../packages/runner/dist/index.mjs'

const fileCount = Number(process.env.VUE_DOCTOR_BENCH_FILES ?? '250')
if (!Number.isInteger(fileCount) || fileCount < 1) {
  throw new Error('VUE_DOCTOR_BENCH_FILES must be a positive integer.')
}

const checkPerformance = process.argv.includes('--check')
const baseline = JSON.parse(await readFile(
  new URL('./doctor-run.baseline.json', import.meta.url),
  'utf8'
))
if (checkPerformance && fileCount !== baseline.fileCount) {
  throw new Error(`Performance check requires VUE_DOCTOR_BENCH_FILES=${baseline.fileCount}.`)
}
const execFileAsync = promisify(execFile)
const coldRunner = fileURLToPath(new URL('./doctor-cold-run.mjs', import.meta.url))

const roots = await Promise.all([
  createFixture('2.7.16', fileCount),
  createFixture('3.5.39', fileCount)
])
const bench = new Bench({
  name: `Doctor Run (${fileCount} SFCs per fixture)`,
  time: 250,
  warmupTime: 100,
  iterations: 1,
  warmupIterations: 1
})

bench
  .add('Vue 2.7 + configured UI contracts', async () => {
    await runDoctor({ root: roots[0] })
  }, { async: true })
  .add('Vue 3 + configured UI contracts', async () => {
    await runDoctor({ root: roots[1] })
  }, { async: true })

try {
  await bench.run()
  const coldDurations = await Promise.all(roots.map(runColdDoctor))
  const metrics = {
    fileCount,
    warmMedianMs: {
      vue27: bench.tasks[0]?.result?.latency?.p50,
      vue3: bench.tasks[1]?.result?.latency?.p50
    },
    coldMs: {
      vue27: coldDurations[0],
      vue3: coldDurations[1]
    }
  }
  console.log(bench.name)
  console.table(bench.table())
  console.log(JSON.stringify(metrics))
  if (process.env.VUE_DOCTOR_BENCH_JSON) {
    await writeFile(
      process.env.VUE_DOCTOR_BENCH_JSON,
      `${JSON.stringify(metrics, null, 2)}\n`,
      'utf8'
    )
  }
  if (checkPerformance) {
    assertWithinPerformanceBudget(metrics, baseline.limits)
  }
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
}

async function runColdDoctor(root) {
  const { stdout } = await execFileAsync(process.execPath, [coldRunner, root], {
    encoding: 'utf8',
    env: { ...process.env, VUE_DOCTOR_DISABLE_CACHE: '1' }
  })
  return JSON.parse(stdout.trim()).durationMs
}

function assertWithinPerformanceBudget(metrics, limits) {
  const failures = []
  for (const version of ['vue27', 'vue3']) {
    const warmMedianMs = metrics.warmMedianMs[version]
    const coldMs = metrics.coldMs[version]
    if (!Number.isFinite(warmMedianMs) || !Number.isFinite(coldMs)) {
      failures.push(`${version} benchmark did not produce finite metrics`)
      continue
    }
    if (warmMedianMs > limits.warmMedianMs[version]) {
      failures.push(
        `${version} warm median ${warmMedianMs.toFixed(1)}ms exceeds ${limits.warmMedianMs[version]}ms`
      )
    }
    if (coldMs > limits.coldMs[version]) {
      failures.push(
        `${version} cold run ${coldMs.toFixed(1)}ms exceeds ${limits.coldMs[version]}ms`
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(`Doctor Run performance regression:\n${failures.join('\n')}`)
  }
}

async function createFixture(vueVersion, count) {
  const root = await mkdtemp(join(tmpdir(), `vue-doctor-bench-${vueVersion.replaceAll('.', '-')}-`))
  const sourceRoot = join(root, 'src')
  const vueRoot = join(root, 'node_modules/vue')
  const libraryRoot = join(root, 'node_modules/example-ui')
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(vueRoot, { recursive: true }),
    mkdir(libraryRoot, { recursive: true })
  ])
  await Promise.all([
    writeJson(join(root, 'package.json'), {
      private: true,
      dependencies: { vue: vueVersion, 'example-ui': '1.0.0' }
    }),
    writeJson(join(root, 'vue-doctor.config.json'), {
      ui: {
        autoDetect: false,
        libraries: [{ package: 'example-ui', aliases: ['@ui'] }]
      }
    }),
    writeJson(join(vueRoot, 'package.json'), { name: 'vue', version: vueVersion }),
    writeJson(join(libraryRoot, 'package.json'), {
      name: 'example-ui',
      version: '1.0.0',
      'web-types': './web-types.json'
    }),
    writeJson(join(libraryRoot, 'web-types.json'), {
      framework: 'vue',
      name: 'example-ui',
      version: '1.0.0',
      contributions: {
        html: {
          'vue-components': [{
            name: 'ExampleButton',
            attributes: [{ name: 'label', type: 'string' }],
            events: [{ name: 'click' }]
          }]
        }
      }
    })
  ])
  await Promise.all(Array.from({ length: count }, (_, index) => (
    writeFile(join(sourceRoot, `Component${index}.vue`), `<script setup>
import { ExampleButton } from '@ui'
const label = 'Button ${index}'
</script>
<template><ExampleButton :label="label" @click="() => {}" /></template>
`, 'utf8')
  )))
  return root
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}
