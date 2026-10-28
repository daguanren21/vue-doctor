# CLI and build-tool integrations

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./usage.zh-CN.md)

## CLI

Install `@daguanren21/vue-doctor` globally or in your project as described in [Install and scan](../../README.md#install-and-scan). For a project-local installation, run:

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

With the package installed, you can add a project script:

```json
{
  "scripts": {
    "doctor": "vue-doctor"
  }
}
```

Vue, Vite, Nuxt, and component libraries are detected from the consuming project; normal diagnosis does not require a Doctor manifest.

## Build tools

The build integration is implemented with [`unplugin`](https://github.com/unjs/unplugin). With `@daguanren21/vue-doctor` installed in the consuming project, use the adapter for that project's existing build tool.

Platform-specific entries keep declarations scoped to that host. Prefer `/vite`, `/webpack`, `/rspack`, `/rollup`, `/rolldown` or `/esbuild` for a single build tool. The advanced `/unplugin` entry exposes upstream's full multi-host API; strict TypeScript consumers of that entry may need its wider optional-host type declarations. This does not apply to the standalone CLI, root API or rule-authoring entries.

Vite:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueDoctor } from '@daguanren21/vue-doctor/vite'

export default defineConfig({
  plugins: [vue(), vueDoctor()]
})
```

webpack:

```ts
import vueDoctor from '@daguanren21/vue-doctor/webpack'

export default {
  plugins: [vueDoctor()]
}
```

Rspack:

```ts
import vueDoctor from '@daguanren21/vue-doctor/rspack'

export default {
  plugins: [vueDoctor()]
}
```

The same package also exports `@daguanren21/vue-doctor/rollup`, `@daguanren21/vue-doctor/rolldown`, and `@daguanren21/vue-doctor/esbuild`. All adapters run the shared Doctor Run; they do not inject application modules.

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
