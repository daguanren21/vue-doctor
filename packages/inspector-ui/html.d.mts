/** Absolute directory containing the built Doctor workspace. */
export declare const inspectorClientAssets: string

export interface InspectorHtmlOptions {
  reportEndpoint?: string
  openEditorEndpoint?: string
}

/** Render the legacy standalone SPA shell owned by the UI package. */
export declare function renderInspectorHtml(options?: InspectorHtmlOptions): string
