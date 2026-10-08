import type { DoctorReport } from '@vue-doctor/core'
import { describe, expect, test, vi } from 'vitest'
import { createDoctorAnalysisSession } from './session.js'

function report(root: string, marker: string): DoctorReport {
  return {
    project: {
      root: `${root}/${marker}`,
      vueFramework: 'unknown',
      uiLibraries: []
    },
    inventory: { root, packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 0, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics: [],
    skippedChecks: [],
    domainCoverage: [{
      domain: 'unclassified',
      status: 'not-covered',
      ruleCount: 0,
      diagnosticCount: 0,
      pendingCheckCount: 0,
      unavailableCheckCount: 0,
      unreportedCheckCount: 0,
      inactiveRuleCount: 0
    }]
  }
}

describe('Doctor analysis session', () => {
  test('deduplicates only an active generation and reruns after completion', async () => {
    let release: (() => void) | undefined
    const runGeneration = vi.fn(async (_options, context) => {
      await new Promise<void>((resolve) => { release = resolve })
      return report('/project', String(context.generation))
    })
    const session = createDoctorAnalysisSession({ root: '/project' }, { runGeneration })

    const first = session.run()
    const duplicate = session.run()
    expect(duplicate).toBe(first)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release!()
    await first

    let releaseSecond: (() => void) | undefined
    runGeneration.mockImplementationOnce(async (_options, context) => {
      await new Promise<void>((resolve) => { releaseSecond = resolve })
      return report('/project', `again-${context.generation}`)
    })
    const second = session.run()
    expect(second).not.toBe(first)
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'))
    releaseSecond!()
    await second
    expect(runGeneration).toHaveBeenCalledTimes(2)
    await session.close()
  })

  test('does not publish an old generation after invalidation races a new run', async () => {
    const releases = new Map<number, () => void>()
    const runGeneration = vi.fn(async (_options, context) => {
      context.recordPhase?.('config', context.generation + 1, 100 + context.generation)
      await new Promise<void>((resolve) => releases.set(context.generation, resolve))
      return report('/project', `generation-${context.generation}`)
    })
    const session = createDoctorAnalysisSession({ root: '/project' }, { runGeneration })

    const old = session.run()
    await vi.waitFor(() => expect(releases.has(0)).toBe(true))
    session.invalidate('src/App.vue')
    const current = session.run()
    await vi.waitFor(() => expect(releases.has(1)).toBe(true))
    releases.get(1)!()
    await current
    releases.get(0)!()
    await old

    expect(session.getLatestReport()?.project.root).toBe('/project/generation-1')
    expect(session.getStats()).toMatchObject({
      generation: 1,
      runsStarted: 2,
      runsCompleted: 2,
      inFlightRuns: 0,
      latestGeneration: 1,
      lastRun: {
        generation: 1,
        phases: { config: 2 }
      }
    })
    await session.close()
  })

  test('close is idempotent, waits for active work and blocks new runs', async () => {
    let release: (() => void) | undefined
    const session = createDoctorAnalysisSession({ root: '/project' }, {
      runGeneration: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return report('/project', 'done')
      }
    })
    const running = session.run()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const closing = session.close()
    expect(session.close()).toBe(closing)
    await expect(session.run()).rejects.toThrow('closed')
    release!()
    await running
    await closing
    expect(session.getLatestReport()).toBeUndefined()
  })
})
