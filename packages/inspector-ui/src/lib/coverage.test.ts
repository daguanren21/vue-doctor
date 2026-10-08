import { describe, expect, test } from 'vitest'
import { coverageSummaryTotal } from './coverage'

describe('coverageSummaryTotal', () => {
  test('keeps the All facet on the unfiltered summary total', () => {
    const summary = [
      { category: 'parse' as const, count: 7 },
      { category: 'skipped' as const, count: 28 }
    ]

    expect(coverageSummaryTotal(summary)).toBe(35)
  })
})
