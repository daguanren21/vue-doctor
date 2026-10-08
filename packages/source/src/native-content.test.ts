import { describe, expect, test } from 'vitest'
import { analyzeSourceText } from './index.js'

describe('opt-in native button child content', () => {
  test.each([
    ['<svg><path d="M0 0" /></svg>', 'graphic-only'],
    ['<svg><title>Save</title><desc>Save icon</desc><path /></svg>', 'graphic-only'],
    ['Save', 'text'],
    ['<span>Save</span><svg />', 'text'],
    ['<svg /><span v-if="visible">Save</span>', 'unknown'],
    ['<svg /><span hidden>Save</span>', 'unknown'],
    ['<svg /><span :hidden="hidden">Save</span>', 'unknown'],
    ['<svg />{{ label }}', 'unknown'],
    ['<svg /><slot />', 'unknown'],
    ['<Icon />', 'unknown'],
    ['<i class="icon-save" />', 'unknown'],
    ['<svg><text>Save</text></svg>', 'unknown'],
    ['<svg><foreignObject><span>Save</span></foreignObject></svg>', 'unknown'],
    ['<svg><use href="#external-symbol" /></svg>', 'unknown'],
    ['<span v-html="label">Fallback</span><svg />', 'unknown'],
    ['Save <slot />', 'text'],
    ['<span v-if="visible">Conditional</span> Save', 'text'],
    ['  \n<!-- no content -->', 'empty']
  ])('classifies %s without guessing runtime content', (children, expected) => {
    const source = `<template><button>${children}</button></template>`
    const button = analyzeSourceText('/fixture.vue', source, { includeNativeElements: true }).components.find((usage) => usage.tag === 'button')
    expect(button?.childContent).toBe(expected)
  })

  test('content replacement makes fallback text unknown, while default scans remain untouched', () => {
    const source = '<template><Wrapper><button v-html="label">Fallback</button><button v-bind="attrs">Save</button></Wrapper></template>'
    const defaults = analyzeSourceText('/fixture.vue', source)
    expect(defaults.components.map((usage) => usage.tag)).toEqual(['Wrapper'])
    expect(defaults.components[0]).not.toHaveProperty('childContent')
    const buttons = analyzeSourceText('/fixture.vue', source, { includeNativeElements: true }).components.filter((usage) => usage.tag === 'button')
    expect(buttons.map((usage) => usage.childContent)).toEqual(['unknown', 'unknown'])
  })
})
