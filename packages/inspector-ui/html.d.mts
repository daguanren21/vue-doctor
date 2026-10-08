export interface InspectorHtmlOptions {
  reportEndpoint?: string
  openEditorEndpoint?: string
}

/** Render the legacy standalone SPA shell owned by the UI package. */
export declare function renderInspectorHtml(options?: InspectorHtmlOptions): string
