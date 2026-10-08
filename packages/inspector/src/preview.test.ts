import { describe, expect, test } from 'vitest'
import {
  createErrorTokenStore,
  createPreviewRequestHandler,
  reportFor
} from '../scripts/preview.mjs'

const coverageProblemCodes = new Set([
  'component-library-contracts-unavailable',
  'component-library-contracts-partial',
  'component-usage-ownership-ambiguous',
  'source-file-parse-failed'
])

const dimensionForDiagnostic = (code: string): string | null => {
  if (code.includes('unsupported-prop')) return 'props'
  if (code.includes('unsupported-event')) return 'events'
  if (code.includes('unsupported-model')) return 'models'
  if (code.includes('unsupported-slot')) return 'slots'
  return null
}

describe('preview report semantics', () => {
  test('keeps the complete fixture free of coverage diagnostics and incomplete coverage', () => {
    const report = reportFor('findings')

    expect(report.coverage.status).toBe('complete')
    expect(report.coverage.componentLibraries.every((library: { status: string, problems: unknown[] }) => {
      return library.status === 'complete' && library.problems.length === 0
    })).toBe(true)
    expect(report.diagnostics.some((diagnostic: { code: string }) => {
      return coverageProblemCodes.has(diagnostic.code)
    })).toBe(false)
  })

  test('only emits unsupported diagnostics for known dimensions in partial coverage', () => {
    const report = reportFor('partial')
    const library = report.coverage.componentLibraries[0]

    expect(report.coverage.status).toBe('partial')
    expect(library.problems.length).toBeGreaterThan(0)
    expect(report.diagnostics.some((diagnostic: { code: string }) => {
      return coverageProblemCodes.has(diagnostic.code)
    })).toBe(false)
    for (const diagnostic of report.diagnostics as Array<{ code: string }>) {
      const dimension = dimensionForDiagnostic(diagnostic.code)
      if (dimension) expect(library.dimensions[dimension]).toBe('known')
    }
  })

  test('keeps blocked coverage diagnostic-free', () => {
    const report = reportFor('blocked')

    expect(report.coverage.status).toBe('blocked')
    expect(report.coverage.componentLibraries[0].status).toBe('blocked')
    expect(report.diagnostics).toEqual([])
  })
})

describe('preview error tokens', () => {
  test('fails once then succeeds independently for two page tokens and releases them', () => {
    const tokens = createErrorTokenStore(4)
    tokens.register('page-a')
    tokens.register('page-b')

    expect(tokens.shouldFail('page-a')).toBe(true)
    expect(tokens.shouldFail('page-a')).toBe(false)
    expect(tokens.shouldFail('page-b')).toBe(true)
    expect(tokens.shouldFail('page-b')).toBe(false)
    expect(tokens.size()).toBe(0)
  })

  test('bounds abandoned page tokens', () => {
    const tokens = createErrorTokenStore(2)
    tokens.register('page-a')
    tokens.register('page-b')
    tokens.register('page-c')

    expect(tokens.size()).toBe(2)
    expect(tokens.shouldFail('page-a')).toBe(false)
    expect(tokens.shouldFail('page-b')).toBe(true)
    expect(tokens.shouldFail('page-c')).toBe(true)
  })

  test('gives two fresh error pages independent fail-then-retry request lifecycles', async () => {
    const pageTokens = ['page-a', 'page-b']
    const handler = createPreviewRequestHandler({
      tokenFactory: () => pageTokens.shift(),
      loadingDelay: 0
    })
    const request = async (url: string) => {
      const result: { status?: number, body?: string } = {}
      await handler({ url }, {
        writeHead(status: number) {
          result.status = status
        },
        end(body: string) {
          result.body = body
        }
      })
      return result
    }

    const firstPage = await request('/error')
    const secondPage = await request('/error')
    expect(firstPage.body).toContain('/api/report/error/page-a')
    expect(secondPage.body).toContain('/api/report/error/page-b')

    expect((await request('/api/report/error/page-a')).status).toBe(503)
    expect((await request('/api/report/error/page-b')).status).toBe(503)
    expect((await request('/api/report/error/page-a')).status).toBe(200)
    expect((await request('/api/report/error/page-b')).status).toBe(200)
  })
})
