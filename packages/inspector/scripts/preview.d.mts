export function createErrorTokenStore(maxTokens?: number): {
  register(token: string): void
  shouldFail(token: string): boolean
  size(): number
}

export function createPreviewRequestHandler(options?: {
  errorTokens?: ReturnType<typeof createErrorTokenStore>
  tokenFactory?: () => string | undefined
  loadingDelay?: number
}): (request: { url?: string }, response: {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}) => Promise<void>

export function reportFor(state: string): {
  coverage: {
    status: string
    componentLibraries: Array<{ status: string; problems: unknown[]; dimensions: Record<string, string> }>
  }
  diagnostics: Array<{ code: string }>
}
