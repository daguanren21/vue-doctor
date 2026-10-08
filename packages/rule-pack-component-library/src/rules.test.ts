import { describe, expect, test } from 'vitest'
import { componentLibraryRuleDefinitions } from './rules.js'

describe('component-library rule catalog', () => {
  test('declares all builtin diagnostics and their current defaults', () => {
    expect(componentLibraryRuleDefinitions).toHaveLength(8)
    expect(new Set(componentLibraryRuleDefinitions.map((rule) => rule.code)).size).toBe(8)
    expect(Object.fromEntries(componentLibraryRuleDefinitions.map((rule) => [rule.code, {
      enabled: rule.defaultEnabled,
      severity: rule.defaultSeverity
    }]))).toEqual({
      'component-event-payload-changed': { enabled: true, severity: 'warning' },
      'component-prop-unsupported': { enabled: true, severity: 'warning' },
      'component-prop-required-missing': { enabled: true, severity: 'error' },
      'component-prop-type-mismatch': { enabled: true, severity: 'warning' },
      'component-attribute-unverified': { enabled: false, severity: 'info' },
      'component-model-unsupported': { enabled: true, severity: 'warning' },
      'component-slot-unsupported': { enabled: true, severity: 'warning' },
      'component-event-unsupported': { enabled: true, severity: 'warning' }
    })
    for (const rule of componentLibraryRuleDefinitions) {
      expect(rule.help.problem).toBe(rule.description)
      expect(rule.requires.ownership).toBe('matched')
    }
  })
})
