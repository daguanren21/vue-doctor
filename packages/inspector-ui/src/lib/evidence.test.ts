import { describe, expect, test } from 'vitest'
import type { Diagnostic } from '@vue-doctor/core'
import { primarySourceLocation } from './evidence'

describe('Inspector evidence helpers', () => {
  test('preserves Git attribution on the primary source location', () => {
    const diagnostic: Diagnostic = {
      code: 'example',
      severity: 'warning',
      message: 'Example diagnostic.',
      file: '/project/src/App.vue',
      evidence: [{
        kind: 'vue-source',
        file: '/project/src/App.vue',
        line: 42,
        git: {
          commit: '0123456789abcdef0123456789abcdef01234567',
          authorName: 'Alice Example',
          summary: 'Fix watcher cleanup'
        }
      }],
      fixes: [],
      confidence: 'high'
    }

    expect(primarySourceLocation(diagnostic)?.git).toEqual({
      commit: '0123456789abcdef0123456789abcdef01234567',
      authorName: 'Alice Example',
      summary: 'Fix watcher cleanup'
    })
  })

  test('does not borrow line or Git attribution from another file', () => {
    const diagnostic: Diagnostic = {
      code: 'example',
      severity: 'warning',
      message: 'Example diagnostic.',
      file: '/project/src/App.vue',
      evidence: [
        { kind: 'vue-source', file: '/project/src/App.vue' },
        {
          kind: 'component-contract',
          file: '/project/node_modules/ui/Button.vue',
          line: 42,
          git: {
            commit: '0123456789abcdef0123456789abcdef01234567',
            authorName: 'Package Author'
          }
        }
      ],
      fixes: [],
      confidence: 'high'
    }

    expect(primarySourceLocation(diagnostic)).toEqual({
      kind: 'vue-source',
      file: '/project/src/App.vue'
    })
  })

  test('uses canonical location while preserving same-file attribution and legacy precision', () => {
    const diagnostic: Diagnostic = {
      code: 'example', severity: 'warning', message: 'Example', confidence: 'high', fixes: [],
      file: '/project/App.vue',
      primaryLocation: { file: '/project/App.vue', precision: 'point', start: { line: 2, column: 1 } },
      evidence: [{ kind: 'contract', file: '/package/types.d.ts', line: 9, column: 20 },
        { kind: 'vue-source', file: '/project/App.vue', line: 2, git: { commit: 'abc', authorName: 'Example' } }]
    }
    expect(primarySourceLocation(diagnostic)).toMatchObject({ file: '/project/App.vue', line: 2, column: 1, git: { commit: 'abc' } })
    diagnostic.primaryLocation = { file: '/project/App.vue', precision: 'file' }
    expect(primarySourceLocation(diagnostic)?.line).toBeUndefined()
  })

  test('matches project-relative primary locations to absolute evidence without borrowing from other files', () => {
    const diagnostic: Diagnostic = {
      code: 'example', severity: 'warning', message: 'Example', confidence: 'high', fixes: [],
      file: '/project/src/App.vue',
      primaryLocation: { file: 'src/App.vue', precision: 'point', start: { line: 2, column: 1 } },
      evidence: [{ kind: 'vue-source', file: '/project/src/App.vue', line: 2,
        message: 'Source finding', git: { commit: 'abc', authorName: 'Example' } }]
    }
    expect(primarySourceLocation(diagnostic)).toEqual({
      file: 'src/App.vue', line: 2, column: 1, kind: 'vue-source',
      message: 'Source finding', git: { commit: 'abc', authorName: 'Example' }
    })
    diagnostic.primaryLocation = { file: 'src/Other.vue', precision: 'file' }
    expect(primarySourceLocation(diagnostic)).toEqual({ file: 'src/Other.vue', kind: 'source' })
  })
})
