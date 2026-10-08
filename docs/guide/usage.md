# CLI and build-tool integrations

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./usage.zh-CN.md)

## CLI

Build and link this checkout as described in the [quick start](../../README.md#quick-start). The registry's unscoped package name belongs to another project. From the linked consuming project:

```bash
pnpm exec vue-doctor
```

The `vue-doctor` command checks the current directory by default and prints a human-readable summary. You can also pass a directory or limit source scanning and diagnostics to a subpath:

```bash
pnpm exec vue-doctor ../my-vue-app
pnpm exec vue-doctor --scope src/features/account
```

Interactive terminals show when scanning starts and the measured completion time. Reports with more than 10 findings are grouped by severity and rule, with errors first. The default summary shows up to eight groups and two representative locations per group; counts still describe the full report.

Choose the output you need:

```bash
pnpm exec vue-doctor --verbose
pnpm exec vue-doctor --inspect
pnpm exec vue-doctor --json-out doctor-report.json
./node_modules/.bin/vue-doctor --json
```

- `--verbose` prints every finding, including evidence and fix suggestions.
- `--inspect` opens the live Inspector; the process stays running until `Ctrl+C`.
- `--json-out` writes the complete report instead of a terminal summary. Interactive terminals confirm the output path.
- `--json` keeps stdout machine-readable. Invoke the local executable directly when piping JSON: package-manager wrappers may prepend their own progress messages. With `--json --inspect`, the Inspector URL goes to stderr.

Grouping does not suppress diagnostics or change exit gates. Partial or blocked coverage remains explicit: fewer displayed findings do not mean the project is clean.

After linking the built package, you can add a project script:

```json
{
  "scripts": {
    "doctor": "vue-doctor"
  }
}
```

Vue, Vite, Nuxt, and component libraries are detected from the consuming project; normal diagnosis does not require a Doctor manifest.

## Build tools

The build integration is implemented with [`unplugin`](https://github.com/unjs/unplugin). With this checkout's built `vue-doctor` package linked into the consuming project, use the adapter for that project's build tool.

Vite:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueDoctor } from 'vue-doctor/vite'

export default defineConfig({
  plugins: [vue(), vueDoctor()]
})
```

webpack:

```ts
import vueDoctor from 'vue-doctor/webpack'

export default {
  plugins: [vueDoctor()]
}
```

Rspack:

```ts
import vueDoctor from 'vue-doctor/rspack'

export default {
  plugins: [vueDoctor()]
}
```

The same package also exports `vue-doctor/rollup`, `vue-doctor/rolldown`, and `vue-doctor/esbuild`. All adapters run the shared Doctor Run; they do not inject application modules.

Vite, webpack and Rspack run for development by default (`run: 'serve'`). Use `run: 'build'` for production builds or `run: 'both'` for both host modes. Rollup, Rolldown and esbuild are build-only hosts and run Doctor by default:

```ts
vueDoctor({
  run: 'build',
  scope: 'src/features/account',
  config: {
    rules: {
      'component-prop-type-mismatch': 'error'
    }
  }
})
```

Diagnostics remain non-blocking build warnings. Vite additionally enables the local Inspector by default:

- Inspector: `/vue-doctor/`
- Current JSON report: `/vue-doctor/api/report.json`

Set `inspector: false` to disable it. webpack and Rspack receive diagnostics through their compilation warnings; the Vite-only Inspector middleware is not injected into those dev servers.
