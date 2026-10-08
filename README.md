# Vue Doctor

[简体中文](./README.zh-CN.md)

Diagnose Vue 2.7 and Vue 3 projects using their installed Vue version and component-library contracts. Inspect findings, source evidence and analysis coverage in the CLI, Inspector or an agent through MCP.

Requires **Node.js >= 20.19.0**. Vue, Vite, Nuxt and UI libraries are detected from your project.

## Quick start

Build this source distribution first. The unscoped npm name belongs to a different project; use this checkout rather than installing that registry package:

```bash
git clone https://github.com/daguanren21/vue-doctor.git
cd vue-doctor
pnpm install --frozen-lockfile
pnpm build
node packages/vue-doctor/dist/cli.mjs /path/to/your-project
```

Large reports are grouped by rule with representative locations. Use `--verbose` for every finding and its evidence, or `--json-out doctor-report.json` for the complete report. Coverage gaps remain visible in the summary.

For repeated use and executable configs/plugins, link the built package into the consuming project. Keep this checkout and its dependencies available:

```bash
pnpm --dir /path/to/your-project link /absolute/path/to/vue-doctor/packages/vue-doctor
pnpm --dir /path/to/your-project exec vue-doctor --scope src
```

## Inspector

```bash
pnpm --dir /path/to/your-project exec vue-doctor --inspect
```

Browse findings, coverage, rules and suppression audits. Filtering reads the current report; **Run again** requests a new scan. The local process stays running until you press `Ctrl+C`.

[Inspector guide](./docs/guide/inspector.md)

## Vite integration

Link this checkout's built `vue-doctor` package as above, then add `vueDoctor()` to your existing Vite plugins:

```ts
import { defineConfig } from 'vite'
import { vueDoctor } from 'vue-doctor/vite'

export default defineConfig({
  plugins: [
    // Keep your existing Vue or Vue 2 plugins here.
    vueDoctor()
  ]
})
```

The Inspector is available at `/vue-doctor/`. webpack, Rspack, Rollup, Rolldown and esbuild adapters are covered in the [integration guide](./docs/guide/usage.md#build-tools).

## Configuration

Optional `doctor.config.ts`:

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  scope: 'src',
  rules: {
    'component-prop-type-mismatch': 'error'
  }
})
```

Vue and component-library checks are built in. Without a project ESLint config, ESLint core delegates are available but disabled by default. Unknown rule codes are configuration errors.

**Existing ESLint config:** Doctor reuses your project's ESLint and `eslint.config.*`, including configs using `@antfu/eslint-config`, `@icebreakers/eslint-config` or local plugins. Rule options, file overrides and ignores follow that config. See [ESLint integration](./docs/guide/configuration.md#project-eslint).

### Third-party UI libraries

Doctor resolves libraries from the consuming project, using component imports and global plugin registrations as evidence. It reads published metadata and type declarations by default, rather than scanning every installed dependency. This works with installed ecosystem packages such as Element Plus (`element-plus`) and Element UI (`element-ui`); the available contracts determine coverage.

For explicit selection, add `ui` to `doctor.config.ts`:

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  ui: {
    autoDetect: true,
    libraries: [
      'element-plus',
      { package: '@acme/ui', aliases: ['@ui'] }
    ],
    runtimeContracts: true
  }
})
```

Use only packages already available to your project. `@acme/ui` is a synthetic example: replace or remove it. `aliases` maps an import root such as `@ui` to that package's contracts; it does not configure your bundler. Set `autoDetect: false` to analyze only `ui.libraries`. The optional `ui.runtimeContracts: true` supplements contracts with statically analyzed published runtime/SFC source; it does not execute the library. Missing exports, dynamic behavior or unresolved contracts remain unknown and leave coverage incomplete—not a clean bill of health. No additional Vue, Vite or UI-library installation is required to inspect an existing project.

[UI contracts, aliases and evidence limits](./docs/guide/configuration.md#project-configuration)

### Custom rule packs

Use `defineRule`, `defineRules` and `oxcRule` from `vue-doctor/rules` to register multiple actual checks in an executable `doctor.config.ts`:

```ts
import { defineDoctorConfig } from 'vue-doctor'
import { defineRule, defineRules, oxcRule } from 'vue-doctor/rules'

const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: { title: 'Avoid var', description: 'Use let or const.' },
      check: oxcRule({
        create: context => ({
          VariableDeclaration(node) {
            if (node.kind === 'var') context.report({ node, message: 'Use let or const.' })
          }
        })
      })
    }),
    'no-debugger': defineRule({
      meta: { title: 'Remove debugger', description: 'Do not commit debugger statements.' },
      check: oxcRule({
        create: context => ({
          DebuggerStatement(node) {
            context.report({ node, message: 'Remove this debugger statement.' })
          }
        })
      })
    })
  }
})

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: { 'team/no-var': 'warning', 'team/no-debugger': 'error' }
})
```

Run `pnpm exec vue-doctor --config ./doctor.config.ts --scope src`. The pack name namespaces each rule; severity overrides use the full code. Keep private policy modules/packages outside the public repository, or in untracked, locally ignored files—do not publish them with your shared config. Rule packs are trusted executable code, not JSON, and Doctor does not download them.

[Complete guide: export a reusable pack, import it and exercise both rules](./docs/guide/custom-rules.md)

## CI

```bash
pnpm exec vue-doctor --fail-on error --fail-on-incomplete-coverage
```

Local scans are non-blocking for findings by default; configuration and operational errors still fail. A run is clean only when findings are empty **and** coverage is complete.

[CI configuration, changed-file scans and local suppression](./docs/guide/configuration.md)

## Agents

Start a standalone MCP server without a dev server:

```bash
node /absolute/path/to/vue-doctor/packages/vue-doctor/dist/cli.mjs mcp /path/to/project
```

For an already running Inspector, connect through Devframe. See the [MCP and agent guide](./docs/guide/mcp.md) for client configuration and skill installation.

## Documentation

| Topic | Guide |
| --- | --- |
| CLI and build tools | [Usage](./docs/guide/usage.md) |
| Configuration, CI and suppression | [Configuration](./docs/guide/configuration.md) |
| Built-in rules and Vue versions | [Rules](./docs/guide/rules.md) |
| Custom AST rules | [Rule authoring](./docs/guide/custom-rules.md) |
| Reports, JavaScript API and coverage | [Reports](./docs/guide/reports.md) |
| Caching and performance | [Performance](./docs/guide/performance.md) |

[All guides](./docs/guide/README.md)
