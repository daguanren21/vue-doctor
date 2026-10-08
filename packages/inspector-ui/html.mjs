import { statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const inspectorClientAssets = fileURLToPath(new URL('./dist/', import.meta.url))

function inspectorAssetVersion() {
  try {
    return String(statSync(join(inspectorClientAssets, 'assets', 'inspector.js')).mtimeMs)
  } catch {
    return '0'
  }
}

/** Render the legacy standalone SPA shell owned by the UI package. */
export function renderInspectorHtml(options = {}) {
  const reportEndpoint = escapeAttribute(options.reportEndpoint ?? '/vue-doctor/api/report.json')
  const openEditorEndpoint = escapeAttribute(options.openEditorEndpoint ?? '/vue-doctor/api/open')
  const assetVersion = inspectorAssetVersion()

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/vue-doctor/favicon.svg?v=probe-v" type="image/svg+xml" />
    <title>Vue Doctor Inspector</title>
    <script type="module" crossorigin src="/vue-doctor/assets/inspector.js?v=${assetVersion}"></script>
    <link rel="stylesheet" crossorigin href="/vue-doctor/assets/inspector.css?v=${assetVersion}">
  </head>
  <body>
    <div id="app" data-report-endpoint="${reportEndpoint}" data-open-editor-endpoint="${openEditorEndpoint}"></div>
  </body>
</html>`
}

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character)
}
