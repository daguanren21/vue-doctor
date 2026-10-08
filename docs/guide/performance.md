# Performance and analysis sessions

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./performance.zh-CN.md)

Doctor Run uses a bounded Piscina worker pool when at least 512 source files and 1 MB of uncached source need analysis. Per-file source analysis and versioned component contracts are cached in the operating system's user cache, so unchanged files are reused by later CLI, Inspector, build-tool, and `--changed` runs. Cache keys include source contents, file paths, Vue version, package version, and contract evidence contents. Declaration caches also validate the files actually read by TypeScript, transitive declarations, configuration and module-resolution probes. Changed inputs are reanalyzed; unverifiable local or linked packages bypass persistent contract reuse. Results returned to separate callers are isolated.

Set `VUE_DOCTOR_DISABLE_CACHE=1` for a cold run. Advanced CI tuning can use `VUE_DOCTOR_MAX_THREADS`, `VUE_DOCTOR_PARALLEL_THRESHOLD`, and `VUE_DOCTOR_PARALLEL_MIN_BYTES`; defaults are four worker threads, 512 files, and 1 MB of uncached source.

Build adapters and the CLI Inspector own an analysis session. Concurrent requests in the same generation share the running analysis. File changes start a new generation; older responses cannot replace newer Inspector results. Sessions reuse bounded content-keyed source facts and a lazy worker pool, then release them on host shutdown. Every explicit rerun reloads configuration and revalidates contract dependencies.

Custom hosts can own the same lifecycle:

```ts
import { createDoctorAnalysisSession } from 'vue-doctor'

const session = createDoctorAnalysisSession({ root: '/path/to/project', scope: 'src' })
try {
  const report = await session.run()
  session.invalidate('src/App.vue')
  const updated = await session.run()
  console.log(report.run, updated.run, session.getStats())
} finally {
  await session.close()
}
```

Operational timings and cache counters are available through `getStats()` and are kept outside the report.
