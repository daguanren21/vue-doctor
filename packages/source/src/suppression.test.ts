import { describe, expect, test } from 'vitest'
import { extractDoctorSuppressions } from './suppression.js'

describe('Doctor source suppression extraction', () => {
  test('reads TypeScript comments while ignoring directive-looking strings', () => {
    const source = [
      'const fake = "// vue-doctor-disable-line string-rule -- not a comment"',
      'risky() // vue-doctor-disable-line inline-rule -- reviewed inline',
      '// vue-doctor-disable-next-line next-rule -- reviewed next line',
      'riskyAgain()'
    ].join('\n')

    const result = extractDoctorSuppressions('/project/src/example.ts', source)

    expect(result.complete).toBe(true)
    expect(result.directives).toEqual([
      expect.objectContaining({
        status: 'valid',
        mode: 'line',
        ruleCode: 'inline-rule',
        reason: 'reviewed inline',
        targetLine: 2,
        location: { start: { line: 2, column: 12 }, end: expect.any(Object) }
      }),
      expect.objectContaining({
        status: 'valid',
        mode: 'next-line',
        ruleCode: 'next-rule',
        targetLine: 4,
        location: { start: { line: 3, column: 4 }, end: expect.any(Object) }
      })
    ])
  })

  test('extracts parser-confirmed Vue template, script and style comments', () => {
    const source = `<template>
  <!-- vue-doctor-disable-next-line template-rule -- template reviewed -->
  <Fixture />
</template>
<script setup lang="ts">
const fake = "// vue-doctor-disable-line fake-rule -- string"
// vue-doctor-disable-next-line script-rule -- script reviewed
run()
</script>
<style>
.fake::before { content: "/* vue-doctor-disable-line fake-style -- string */"; }
/* vue-doctor-disable-next-line style-rule -- style reviewed */
.fixture {}
</style>`

    const result = extractDoctorSuppressions('/project/src/App.vue', source)

    expect(result.complete).toBe(true)
    expect(result.directives.map((directive) => ({
      code: directive.ruleCode,
      mode: directive.mode,
      targetLine: directive.targetLine
    }))).toEqual([
      { code: 'template-rule', mode: 'next-line', targetLine: 3 },
      { code: 'script-rule', mode: 'next-line', targetLine: 8 },
      { code: 'style-rule', mode: 'next-line', targetLine: 13 }
    ])
  })

  test('recognizes real HTML and CSS-family comments', () => {
    const html = extractDoctorSuppressions('/project/index.html', [
      '<!doctype html>',
      '<main>',
      '<!-- vue-doctor-disable-next-line html-rule -- reviewed -->',
      '<section />',
      '</main>'
    ].join('\n'))
    const scss = extractDoctorSuppressions('/project/theme.scss', [
      '$fake: "/* vue-doctor-disable-line fake -- string */";',
      '$asset: url(http://cdn.example/vue-doctor-disable-line fake-url -- string);',
      '// vue-doctor-disable-next-line sass-rule -- reviewed',
      '.fixture {}',
      '.inline { color: red; // vue-doctor-disable-line inline-rule -- reviewed',
      '}',
      '/* vue-doctor-disable-line css-rule -- reviewed */ .other {}'
    ].join('\n'))

    expect(html.directives).toEqual([
      expect.objectContaining({ ruleCode: 'html-rule', targetLine: 4, status: 'valid' })
    ])
    expect(scss.directives.map((directive) => [directive.ruleCode, directive.targetLine])).toEqual([
      ['sass-rule', 4],
      ['inline-rule', 5],
      ['css-rule', 7]
    ])
  })

  test('reports malformed directives and never trusts comments after parse uncertainty', () => {
    const invalid = extractDoctorSuppressions(
      '/project/src/valid.ts',
      '// vue-doctor-disable-next-line known-rule\nrun()'
    )
    const uncertain = extractDoctorSuppressions(
      '/project/src/broken.ts',
      '// vue-doctor-disable-next-line known-rule -- reviewed\nconst = broken'
    )
    const noCandidate = extractDoctorSuppressions('/project/src/broken.ts', 'const = broken')

    expect(invalid).toMatchObject({
      complete: true,
      directives: [{ status: 'invalid', message: expect.stringContaining('Expected') }]
    })
    expect(uncertain.complete).toBe(false)
    expect(uncertain.directives).toEqual([
      expect.objectContaining({ status: 'invalid', message: expect.stringContaining('could not be parsed reliably') })
    ])
    expect(noCandidate).toEqual({
      file: '/project/src/broken.ts',
      complete: true,
      directives: [],
      issues: []
    })
  })

  test('targets the first line after a multiline next-line comment', () => {
    const result = extractDoctorSuppressions('/project/src/example.ts', [
      '/*',
      ' * vue-doctor-disable-next-line known-rule -- reviewed',
      ' */',
      'run()'
    ].join('\n'))

    expect(result.directives).toEqual([
      expect.objectContaining({ mode: 'next-line', targetLine: 4, ruleCode: 'known-rule' })
    ])
  })

  test('does not treat an external style block as uncertainty in inline Vue comments', () => {
    const result = extractDoctorSuppressions('/project/src/App.vue', [
      '<template>',
      '<!-- vue-doctor-disable-next-line known-rule -- reviewed -->',
      '<Fixture />',
      '</template>',
      '<style src="./theme.css"></style>'
    ].join('\n'))

    expect(result.complete).toBe(true)
    expect(result.directives).toEqual([
      expect.objectContaining({ status: 'valid', ruleCode: 'known-rule', targetLine: 3 })
    ])
  })
})
