import { expect, test } from 'vitest'
import {
  INSPECTOR_EDITORS,
  InspectorProtocolError,
  VUE_DOCTOR_RPC_METHODS,
  VUE_DOCTOR_SHARED_STATE_KEY,
  assertOpenEditorRequest,
  assertQueryFindingsRequest,
  isInspectorEditor
} from './index.js'

const snapshotId = 'vds1:0123456789abcdef0123456789abcdef'

test('keeps the editor contract browser-safe and finite', () => {
  expect(INSPECTOR_EDITORS).toEqual(['vscode', 'cursor', 'webstorm'])
  expect(isInspectorEditor('cursor')).toBe(true)
  expect(isInspectorEditor('idea')).toBe(false)
  expect(() => assertOpenEditorRequest({ snapshotId, id: 'finding-1', editor: 'webstorm' })).not.toThrow()
})

test('publishes one shared source of truth for transport method names', () => {
  expect(VUE_DOCTOR_SHARED_STATE_KEY).toBe('state')
  expect(Object.keys(VUE_DOCTOR_RPC_METHODS)).toEqual([
    'getSnapshot', 'queryFindings', 'getFinding', 'getCoverage', 'queryRules', 'queryAudit',
    'getAudit', 'exportReport', 'run', 'getSnippet', 'openEditor'
  ])
})

test('rejects unknown request fields at the protocol boundary', () => {
  expect(() => assertQueryFindingsRequest({ snapshotId, unexpected: true })).toThrowError(
    new InspectorProtocolError('invalid-request', 'Unknown request field: unexpected.')
  )
})
