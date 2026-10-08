import { describe, expect, test, vi } from 'vitest'
import type { Diagnostic } from '@vue-doctor/core'
import {
  enrichDiagnosticsWithGitAttribution,
  isBlameableRelativePath,
  parseGitBlamePorcelain,
  type GitCommandRunner
} from './git-attribution.js'

const commit = '0123456789abcdef0123456789abcdef01234567'
const blame = `${commit} 10 42 1
author Alice Example
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
summary Fix watcher cleanup
filename src/App.vue
\twindow.addEventListener('scroll', onScroll)
`

describe('Git diagnostic attribution', () => {
  test('parses author, commit, timestamp, and summary from porcelain blame', () => {
    expect(parseGitBlamePorcelain(blame).get(42)).toEqual({
      commit,
      authorName: 'Alice Example',
      authoredAt: '2023-11-14T22:13:20.000Z',
      summary: 'Fix watcher cleanup'
    })
  })

  test('marks uncommitted blame records explicitly', () => {
    const output = `${'0'.repeat(40)} 42 42 1
author Not Committed Yet
author-time 1700000000
summary Version of src/App.vue from src/App.vue
filename src/App.vue
\tchanged()
`

    expect(parseGitBlamePorcelain(output).get(42)).toMatchObject({
      commit: '0'.repeat(40),
      authorName: 'Not Committed Yet',
      uncommitted: true
    })
  })

  test('handles POSIX and Windows repository path boundaries', () => {
    expect(isBlameableRelativePath('src/App.vue')).toBe(true)
    expect(isBlameableRelativePath('src\\App.vue')).toBe(true)
    expect(isBlameableRelativePath('..generated/App.vue')).toBe(true)
    expect(isBlameableRelativePath('../outside/App.vue')).toBe(false)
    expect(isBlameableRelativePath('..\\outside\\App.vue')).toBe(false)
    expect(isBlameableRelativePath('node_modules/pkg/index.js')).toBe(false)
    expect(isBlameableRelativePath('node_modules\\pkg\\index.js')).toBe(false)
  })

  test('enriches source evidence without exposing author email', async () => {
    const diagnostic: Diagnostic = {
      code: 'vue-lifecycle-require-cleanup',
      severity: 'warning',
      message: 'Missing cleanup.',
      file: 'src/App.vue',
      evidence: [{ kind: 'vue-source', file: 'src/App.vue', line: 42 }],
      fixes: [],
      confidence: 'high'
    }
    const runGit = vi.fn<GitCommandRunner>(async (_cwd, args) => (
      args[0] === 'rev-parse' ? '/repo\n' : blame
    ))

    const [result] = await enrichDiagnosticsWithGitAttribution('/repo', [diagnostic], runGit)

    expect(result?.evidence[0]?.git).toEqual({
      commit,
      authorName: 'Alice Example',
      authoredAt: '2023-11-14T22:13:20.000Z',
      summary: 'Fix watcher cleanup'
    })
    expect(runGit).toHaveBeenLastCalledWith('/repo', [
      'blame',
      '--line-porcelain',
      '-L',
      '42,42',
      '--',
      'src/App.vue'
    ])
  })

  test('requests only sparse diagnostic lines from each file', async () => {
    const second = blame.replace(`${commit} 10 42 1`, `${commit} 20 100 1`)
    const diagnostic: Diagnostic = {
      code: 'example',
      severity: 'warning',
      message: 'Example.',
      evidence: [
        { kind: 'vue-source', file: 'src/App.vue', line: 42 },
        { kind: 'vue-source', file: 'src/App.vue', line: 100 }
      ],
      fixes: [],
      confidence: 'high'
    }
    const runGit = vi.fn<GitCommandRunner>(async (_cwd, args) => (
      args[0] === 'rev-parse' ? '/repo\n' : `${blame}${second}`
    ))

    const [result] = await enrichDiagnosticsWithGitAttribution('/repo', [diagnostic], runGit)

    expect(result?.evidence.every((entry) => entry.git?.authorName === 'Alice Example')).toBe(true)
    expect(runGit).toHaveBeenLastCalledWith('/repo', [
      'blame',
      '--line-porcelain',
      '-L',
      '42,42',
      '-L',
      '100,100',
      '--',
      'src/App.vue'
    ])
  })

  test('leaves diagnostics unchanged outside a Git repository', async () => {
    const diagnostics: Diagnostic[] = [{
      code: 'example',
      severity: 'warning',
      message: 'Example.',
      evidence: [],
      fixes: [],
      confidence: 'high'
    }]
    const runGit: GitCommandRunner = async () => {
      throw new Error('not a repository')
    }

    await expect(enrichDiagnosticsWithGitAttribution('/tmp/project', diagnostics, runGit)).resolves.toBe(diagnostics)
  })
})
