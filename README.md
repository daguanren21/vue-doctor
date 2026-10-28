# Vue Doctor

[简体中文](./README.zh-CN.md)

Diagnose Vue 2.7 and Vue 3 projects using their installed Vue version and component-library contracts. Explore findings, source evidence and coverage in the CLI, Inspector or an MCP client.

Use **Node.js 26** (supported engines: `^22.18.0 || >=24.11.0`). Run with Node.js even if dependencies are installed with Bun; explicit Bun runtime execution is not supported. Vue, Vite, Nuxt and UI libraries are detected from your project, not installed by Doctor.

## Install and scan

Built-in rules and internal modules are included in **`@daguanren21/vue-doctor`**. No separate rule-pack or internal npm packages are needed.

```bash
npm install -g @daguanren21/vue-doctor
vue-doctor /absolute/path/to/project
vue-doctor /absolute/path/to/project --scope src
vue-doctor /absolute/path/to/project --inspect
```

Inside the project, `vue-doctor` scans the current directory. `--scope` limits diagnostics to a project-relative file or directory; it does not select a different project root. Use `--verbose` for full finding details or `--json-out doctor-report.json` for a complete report.

For TypeScript configuration, custom-rule imports or build-tool integration, also make the **same public package** available in the consuming project:

```bash
npm install --save-dev @daguanren21/vue-doctor
```

A global CLI installation alone does not make package imports resolvable from your project's config files.

## Inspector and Vite

`vue-doctor /absolute/path/to/project --inspect` opens a local Inspector and keeps the process running until `Ctrl+C`. Browse findings, source evidence, coverage, rules and suppression audits. Filtering reads the current snapshot; **Run again** requests a new scan.

To integrate with an existing Vite project, add `vueDoctor()` to its existing `vite.config.ts` plugins:

```ts
import { defineConfig } from 'vite'
import { vueDoctor } from '@daguanren21/vue-doctor/vite'

export default defineConfig({
  plugins: [
    // Keep your existing Vue or Vue 2 plugin here.
    vueDoctor()
  ]
})
```

Start your normal Vite dev server and open `/vue-doctor/`. Vite is needed only for this integration, not for standalone CLI scans. See the [Inspector guide](./docs/guide/inspector.md) and [other build tools](./docs/guide/usage.md#build-tools).

## Wrap and enable a custom rule

`defineRule` wraps a reusable check; `oxcRule` supplies its script AST visitor. Save this separate module as **`doctor-rules.ts`** in the consuming project:

```ts
import { defineRule, oxcRule } from '@daguanren21/vue-doctor/rules'

export const noDebugger = defineRule({
  meta: {
    title: 'Remove debugger statements',
    description: 'Do not commit debugger statements.'
  },
  check: oxcRule({
    create: context => ({
      DebuggerStatement(node) {
        context.report({ node, message: 'Remove this debugger statement.' })
      }
    })
  })
})
```

Register it with `defineRules` and enable it in **`doctor.config.ts`** beside that module:

```ts
import { defineDoctorConfig } from '@daguanren21/vue-doctor'
import { defineRules } from '@daguanren21/vue-doctor/rules'
import { noDebugger } from './doctor-rules.ts'

const teamRules = defineRules({
  name: 'team',
  rules: { 'no-debugger': noDebugger }
})

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: { 'team/no-debugger': 'error' }
})
```

The pack name namespaces the rule: severity uses the **full code** `team/no-debugger` (`error`, `warning`, `info` or `off`). Importing a rule alone does not register it; `rulePacks` does. Unknown rule codes are configuration errors.

To try it, create **`src/rule-demo.ts`** in a scratch project:

```ts
debugger
export {}
```

From that project, run:

```bash
vue-doctor --config ./doctor.config.ts --scope src/rule-demo.ts --json
```

Expect a `team/no-debugger` error with a source location. Remove `debugger` to resolve that finding; other enabled rules and coverage gaps may remain. These are teaching rules—prefer existing ESLint rules when they meet your needs.

Configs and imported packs are **trusted executable code**. Doctor does not download packs; JSON config cannot import rule functions. Keep private policies in external/private modules, or untracked, locally ignored files; never publish them with shared configuration. See [rule authoring](./docs/guide/custom-rules.md) for reusable packs, parser backends and evidence requirements.

## MCP client

After the global installation above, add this stdio server to your MCP client's configuration. Replace the absolute project path:

```json
{
  "mcpServers": {
    "vue-doctor": {
      "command": "vue-doctor",
      "args": ["mcp", "/absolute/path/to/project"]
    }
  }
}
```

The client must find `vue-doctor` on its `PATH`; otherwise use the absolute executable path as `command`. No dev server or browser is required. The server owns its session until the client disconnects; stdout is reserved for MCP messages. Add `"--scope", "src"` to `args` to constrain diagnostics.

Start with `vue-doctor_help` and `vue-doctor_get-overview`, then query findings, source and coverage using the returned `snapshotId`. These tools do not edit source files or apply fixes. `vue-doctor_rescan` explicitly runs analysis again after authorized changes; empty filtered results do not prove a clean project. See [MCP, Inspector connections and agent skills](./docs/guide/mcp.md).

## Coverage and CI

Vue and component-library checks are built in. Doctor resolves UI contracts from the consuming project's imports, plugin registrations, published metadata and types. Missing contracts and dynamic behavior remain unknown, not verified. Existing project ESLint configuration can also supply rules; without one, ESLint core delegates are available but disabled by default.

Local scans do not fail on findings by default; configuration and operational errors still fail. For CI:

```bash
vue-doctor /absolute/path/to/project --fail-on error --fail-on-incomplete-coverage
```

A project is clean only when findings are empty **and coverage is complete**. See [configuration, ESLint, UI contracts and suppression](./docs/guide/configuration.md).

## More guides

[CLI and build tools](./docs/guide/usage.md) · [Built-in rules](./docs/guide/rules.md) · [Reports and JavaScript API](./docs/guide/reports.md) · [Performance](./docs/guide/performance.md) · [All guides](./docs/guide/README.md)
