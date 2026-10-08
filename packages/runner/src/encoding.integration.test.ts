import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { shouldFailDoctorRun } from '@vue-doctor/core'
import { runDoctor } from './run.js'

test.each(['App.vue', 'state.ts'])('invalid UTF-8 in %s keeps coverage incomplete and prevents suppression', async (name) => {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-invalid-encoding-'))
  const ruleCode = name.endsWith('.vue') ? 'vue-shallow-ref-nested-mutation' : 'encoding/check'
  try {
    await mkdir(join(root, 'node_modules/vue'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '3.5.39' } }))
    await writeFile(join(root, 'node_modules/vue/package.json'), JSON.stringify({ name: 'vue', version: '3.5.39' }))
    const script = Buffer.concat([
      Buffer.from(`import { shallowRef } from 'vue'\nconst state = shallowRef({ count: 0 })\n// invalid byte: `),
      Buffer.from([0xff]),
      Buffer.from(`\n// vue-doctor-disable-next-line ${ruleCode} -- Legacy reviewed\nstate.value.count++\n`)
    ])
    const contents = name.endsWith('.vue')
      ? Buffer.concat([Buffer.from('<script setup lang="ts">\n'), script, Buffer.from('</script><template><div /></template>')])
      : script
    await writeFile(join(root, name), contents)
    const report = await runDoctor({ root, config: { gitAttribution: false,
      ...(name.endsWith('.ts') ? { rulePacks: [{ name: 'encoding', sourceExtensions: ['.ts'],
        rules: [{ code: ruleCode, title: 'Encoding test', description: 'Retained source finding.' }],
        run: () => ({ diagnostics: [{ code: ruleCode, severity: 'warning' as const, message: 'Finding retained.',
          confidence: 'high' as const, fixes: [], file: join(root, name),
          evidence: [{ kind: 'source', file: join(root, name), line: 5, column: 1 }] }], skippedChecks: [] })
      }] } : {})
    } })
    expect(report.coverage.source.status).toBe('partial')
    expect(report.coverage.status).not.toBe('complete')
    expect(report.coverage.source.failedFiles).toContainEqual(expect.objectContaining({ file: join(root, name), message: expect.stringContaining('UTF-8') }))
    expect(report.diagnostics.some(item => item.code === ruleCode)).toBe(true)
    expect(report.suppressionAudit).toContainEqual(expect.objectContaining({ status: 'invalid', ruleCode, diagnostics: [] }))
    expect(report.suppressionAudit?.some(item => item.status === 'applied')).toBe(false)
    expect(shouldFailDoctorRun({ diagnostics: report.diagnostics, coverageStatus: report.coverage.status, config: { failOnIncompleteCoverage: true } })).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
