import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUi } from '@devframes/hub-ui'

/** Node host asset locator, resolved within this package in npm and pnpm installs. */
export const inspectorClientAssets = fileURLToPath(new URL('./dist/', import.meta.url))

/** Build the branded Hub shell supplied explicitly to an Inspector host. */
export function createInspectorHubUi(base = '/vue-doctor/') {
  return createUi({
    branding: {
      productName: 'Vue Doctor',
      primaryColor: '#10b981',
      logo: `${base}favicon.svg?v=probe-v`,
      favicon: `${base}favicon.svg?v=probe-v`,
      windowTitle: 'Vue Doctor Inspector',
      tagline: 'Diagnostics, evidence, coverage, rules, and suppression audits.'
    },
    embeddedVisibility: 'normal',
    dockPreferences: {
      categoryOrder: { framework: 10 },
      maxVisibleItems: 6,
      defaultMode: 'edge',
      defaultPosition: 'left'
    }
  })
}

/** Read one compatibility asset without exposing the UI package layout to the backend. */
export async function readInspectorAsset(name, assetsDir = inspectorClientAssets) {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.includes('..') || normalized.startsWith('/')) return undefined
  const path = join(assetsDir, normalized)
  try {
    await access(path)
    return {
      body: await readFile(path),
      contentType: inspectorAssetContentType(name)
    }
  } catch {
    return undefined
  }
}

export function inspectorAssetContentType(name) {
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  return 'text/html; charset=utf-8'
}

export { renderInspectorHtml } from './html.mjs'
