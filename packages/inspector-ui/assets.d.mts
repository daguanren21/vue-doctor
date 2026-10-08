import type { DevframeHubUi } from '@devframes/hub/initiate'

/** Absolute directory containing the built Doctor workspace. */
export declare const inspectorClientAssets: string
/** Build the branded Hub shell supplied explicitly to an Inspector host. */
export declare function createInspectorHubUi(base?: string): DevframeHubUi

export interface InspectorAsset {
  body: Uint8Array
  contentType: string
}

/** Read one compatibility asset without exposing the UI package layout to the backend. */
export declare function readInspectorAsset(name: string, assetsDir?: string): Promise<InspectorAsset | undefined>
export declare function inspectorAssetContentType(name: string): string

export { renderInspectorHtml } from './html.mjs'
export type { InspectorHtmlOptions } from './html.mjs'
