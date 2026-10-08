import { describe, expect, test } from 'vitest'
import { defaultInspectorLocale, inspectorMessages } from './i18n.js'

describe('Inspector localization', () => {
  test('defaults Chinese browsers to Chinese and all other browsers to English', () => {
    expect(defaultInspectorLocale('zh-CN')).toBe('zh')
    expect(defaultInspectorLocale('zh')).toBe('zh')
    expect(defaultInspectorLocale('en-US')).toBe('en')
  })

  test('contains translated workbench labels', () => {
    expect(inspectorMessages.en.findings).toBe('Findings')
    expect(inspectorMessages.zh.findings).toBe('诊断')
    expect(inspectorMessages.en.clearFilters).toBe('Clear filters')
    expect(inspectorMessages.zh.clearFilters).toBe('清除筛选')
    expect(inspectorMessages.en.openFile).toBe('Open file')
    expect(inspectorMessages.zh.openFile).toBe('在编辑器中打开')
  })
})
