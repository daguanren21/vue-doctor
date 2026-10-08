const root = process.argv[2]
if (!root) {
  throw new Error('Doctor cold benchmark requires a fixture root.')
}

const startedAt = performance.now()
const { runDoctor } = await import('../packages/runner/dist/index.mjs')
await runDoctor({ root })
console.log(JSON.stringify({ durationMs: performance.now() - startedAt }))
