import { describe, expect, test } from 'vitest'
import { renderInspectorHtml } from '../assets.mjs'

describe('renderInspectorHtml', () => {
  test('uses the canonical standalone endpoints by default', () => {
    expect(renderInspectorHtml()).toContain('data-report-endpoint="/vue-doctor/api/report.json"')
    expect(renderInspectorHtml()).toContain('data-open-editor-endpoint="/vue-doctor/api/open"')
  })

  test('renders the Inspector SPA shell and asset tags', () => {
    const html = renderInspectorHtml({
      reportEndpoint: '/__vue-doctor__/api/report.json',
      openEditorEndpoint: '/__vue-doctor__/api/open'
    })

    expect(html).toContain('<title>Vue Doctor Inspector</title>')
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />')
    expect(html).toContain('data-report-endpoint="/__vue-doctor__/api/report.json"')
    expect(html).toContain('data-open-editor-endpoint="/__vue-doctor__/api/open"')
    expect(html).toContain('/vue-doctor/assets/inspector.js')
    expect(html).toContain('/vue-doctor/assets/inspector.css')
  })

  test('escapes endpoint values before embedding them into the page', () => {
    const html = renderInspectorHtml({ reportEndpoint: '\"><script>alert(1)</script>' })
    expect(html).toContain('data-report-endpoint="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
