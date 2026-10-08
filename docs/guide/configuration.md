# Configuration and CI

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./configuration.zh-CN.md)

## Project configuration

Optional project config (first match wins):

1. `doctor.config.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, `.json`, in that order.
2. `vue-doctor.config.*`, in the same extension order.
3. `package.json#vueDoctor`, or `package.json#vue-doctor` when `vueDoctor` is absent.

An explicit CLI `--config` path takes precedence over discovery.

Executable configuration modules and their local imports load synchronously so each actual run can reload local dependency changes. Top-level `await` is unsupported; put asynchronous analysis in a rule pack’s `run()` method.

```json
{
  "scope": "src",
  "rules": {
    "vue-prefer-use-template-ref": "info",
    "component-prop-type-mismatch": "error"
  },
  "failOn": "error",
  "failOnIncompleteCoverage": true
}
```

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  ui: {
    autoDetect: true,
    libraries: [
      'element-plus',
      { package: '@acme/ui', aliases: ['@ui'] }
    ]
  },
  rules: {
    'vue-prefer-define-model': 'info'
  },
  failOn: 'error'
})
```

`ui.libraries` explicitly connects installed UI/component-library packages. `aliases` maps project import roots such as `@ui` back to the package that owns the contracts. With `autoDetect: true`, Vue Doctor analyzes packages observed through direct component imports and global plugin registration; it does not parse every dependency in `node_modules`. Set `autoDetect: false` when only explicitly configured libraries should be analyzed. Configured packages are resolved from the consuming project's `node_modules`, including packages that are not top-level dependencies. Doctor Run reads metadata and declarations by default, including slot names explicitly referenced by metadata descriptions. Set `ui.runtimeContracts: true` when published runtime/SFC source should supplement incomplete slot, prop, and fallthrough contracts.

Runtime-only components require a verified public export, not merely a matching file or component name. Doctor follows static package-local ESM/CommonJS exports and supported webpack entry/source-map links to published source. Missing, stale, escaping or unsupported source-map evidence does not establish a public component. Vue 2 `<template functional>` components are supported without assuming stateful attribute/listener fallthrough or a default model.

With runtime contracts enabled, published SFCs can also supply literal event names from Options API `$emit` calls, verified `setup(props, { emit })` or `setup(props, context)` emitters, template listeners and explicit `emits` declarations. Setup emitter aliases and nested callbacks are followed only when lexical identity is preserved; shadowed, reassigned, escaped or overwritten bindings are not positive evidence. This is positive evidence only: missing names, dynamic emission and incomplete payload signatures remain unknown. Doctor parses source without executing prop defaults or mixin factories; it does not turn an observed event into a closed event list.

Named default exports in published JS, JSX, TS and TSX modules can supply the same interaction evidence, including options wrapped in a verified `defineComponent` import from Vue. Static package-local `extends` and mixins preserve model/event provenance and method overrides. Mutated or escaped option bindings, unknown inheritance and dynamic listener-forwarding targets do not establish support; an overridden inherited method cannot prove an event on the child.

Nested class instances and overwritten watcher/accessor callbacks are not component event evidence. Slot, loop, script-setup and handler-local bindings named `$emit` are not borrowed as component emitters. A `<script setup>` block replaces the normal `setup` callback and any generated `emits` declaration, including in inherited SFCs. Mutations or escapes through option aliases, containers or callbacks invalidate inherited evidence; stable aliases remain supported. Inherited `setup` callbacks are not used as cross-version event proof because Vue 2 and Vue 3 execute them differently.

Event checks distinguish support from payload use. Vue 2 `.native` listeners target the root DOM element and do not require a component event contract; Vue 3 or an unresolved version does not receive this exemption. A supported event needs no payload signature when its handler provably ignores the payload. Payload reads, defaults/destructuring, dynamic dispatch, overwritten or escaped handlers remain unresolved. Metadata listing only an event name does not prove a zero-argument signature: Web Types must explicitly supply an empty argument list to establish that contract, while Vetur event names retain unknown payloads.

Model checks use the consuming package's Vue version. Vue 2 needs a statically resolved `model` option or verified default `value`/`input` mapping; package-local static `extends` and mixins are followed with cycle and package-boundary guards. Vue 3 uses `modelValue`/`update:modelValue`, or the explicit model argument. Unresolved versions, dynamic model mappings and unreadable inherited options remain required skipped checks. The same mapping determines whether `v-model` supplies a required prop. Direct callers of `diagnoseComponentLibraryUsageResult` should provide `vueVersion` and, for mixed-version workspaces, per-file `vueVersions`; an explicit unresolved per-file entry does not inherit the root version.

An unresolved `v-bind` spread blocks a required-prop check only when a required prop may still be missing; explicit props and version-correct `v-model` bindings count as supplied. Direct `analyzeComponentLibraries` callers should also provide per-file `vueVersions` so coverage uses the same event applicability as diagnosis. Irrelevant checks becoming inapplicable does not turn unknown contract dimensions into known ones.

### Project aliases and application ownership

Application discovery reads explicit `compilerOptions.paths` from the consuming package's `tsconfig.json`, or `jsconfig.json` when no tsconfig is present. Local JSONC `extends`, mapping origins and ordered target fallbacks are supported. Declaration-only redirects and erased type imports do not become runtime application edges. Doctor does not infer `@ = src` or execute Vite/Webpack configuration to obtain aliases; unresolved, nonlocal or ambiguous configuration remains visible as incomplete context. Paths cannot escape the consuming package through aliases or symlinks.

Alias matching follows TypeScript precedence: exact matches first, then the longest matching prefix; equal-length prefixes keep declaration order.

Vue 2 constructor registrations are associated with matching root instances through eager runtime imports, including entry/router modules. Registration-only modules are not extra applications; lazy or conditional installs are not proof of global availability. Vue 3 registrations remain scoped to their own application.

A scanned component outside the discovered application graph cannot borrow that application's global registrations. Import and locally register its dependencies, or establish the actual statically discoverable application import path. Doctor does not exclude these files or invent application ownership to make coverage complete.

Literal `import.meta.glob` calls contribute candidate modules to application reachability without widening diagnostic targets. Relative and project-root paths, a single explicitly mapped alias target, static pattern arrays and exclusions are supported. Lazy candidates do not prove plugin installation; only `{ eager: true }` contributes eager module edges. Dynamic patterns/options, resource queries such as `?raw`, unsupported options and ambiguous aliases remain unresolved. Expansion excludes dependency, nested-package and escaping symlink paths.

Vite's keys-only `Object.keys(import.meta.glob(...))` form contributes no module edges, even with `eager: true`. Expansion preserves literal directory names containing glob metacharacters and disables extglob operators to match Vite's module transform. Patterns requiring `.` or repeated-separator normalization after a dynamic directory remain unresolved because Vite's development and production transforms can load different modules.

## Project ESLint

By default, Doctor uses the consuming project's ESLint when it finds an `eslint.config.*`. Preset imports such as `@antfu/eslint-config` and `@icebreakers/eslint-config`, custom plugins, parsers, processors, options and per-file overrides are loaded by that ESLint. You do not need a Doctor-specific preset adapter.

Use `eslint` in Doctor config to select a mode or a specific ESLint config:

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  eslint: {
    mode: 'project',
    configFile: './eslint.config.mjs'
  }
})
```

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Use project config when present; otherwise retain the opt-in built-in ESLint delegates. |
| `project` | Require project ESLint and a configuration. |
| `builtin` | Use Doctor's isolated, opt-in ESLint core delegates. |
| `off` | Disable the general ESLint integration. |

Project mode requires the consuming package to resolve ESLint 9 or newer. `eslint.configFile` is root-relative or absolute and is available in `auto` and `project` modes. It is separate from CLI `--config`, which selects Doctor config. TypeScript ESLint configs follow the consuming ESLint's loader requirements; required loaders must be available to that project.

The runtime must also satisfy the project's ESLint, parser and plugin Node.js requirements, which may be higher than Doctor's minimum. An incompatible project dependency fails configuration loading.

With a scoped run such as `--scope src`, a config found inside that scope also works with ESLint 9's cwd-based lookup; ESLint 10 retains its native per-file lookup. An explicit `eslint.configFile` keeps its normal project-root-relative matching semantics.

Project rule IDs retain their aliases: `vue/no-mutating-props` becomes `eslint/vue/no-mutating-props`, and `ts/no-explicit-any` becomes `eslint/ts/no-explicit-any`. Findings preserve the severity and location emitted for each file. Doctor `rules` can override report severity or turn off a registered check; it does not change project rule options or expand the project's applicable files.

ESLint ignores apply only to ESLint checks. Vue and component-contract analysis still use Doctor targets. Missing ESLint, invalid config and plugin-loading errors stop the run without falling back to built-in rules. File parse or type-analysis failures leave incomplete coverage.

Configured targets include extensionless files such as `bin/tool`. Processor rule discovery and execution use the same source snapshot, including when its text selects a different virtual-file language. Virtual rules retain their documentation even when they report no findings. A failed snapshot read is not retried from disk: the report retains the read error and a required skipped check instead of claiming complete coverage.

Readable source remains eligible for project ESLint even when Vue Doctor's Vue parser cannot construct any blocks, such as an empty SFC. The project's parser owns ESLint syntax acceptance. ESLint diagnostics for unavailable rules referenced by inline directives are also retained instead of aborting the run.

Vue template text may contain a literal `<`, such as a comparison or character list. Doctor retains that text when both the Vue descriptor and template AST preserve it. Malformed closing tags, duplicate top-level blocks and empty SFCs still leave source analysis incomplete; this does not prevent readable bytes from reaching project ESLint.

## CI and CLI overrides

```bash
vue-doctor --version
vue-doctor --fail-on error
vue-doctor --fail-on warning --fail-on-incomplete-coverage
vue-doctor --config ./doctor.config.json
vue-doctor rules list
vue-doctor rules explain component-prop-required-missing
```

By default findings and incomplete coverage do not fail local scans. Configuration and operational errors still fail the command. Opt into diagnostic gating with `--fail-on` or config `failOn`, and require complete coverage with `--fail-on-incomplete-coverage` or `failOnIncompleteCoverage: true`.

`--version` (or `-v`) prints the installed Vue Doctor version and exits without loading project configuration or scanning files.

Install a starter GitHub Actions workflow:

```bash
pnpm exec vue-doctor ci install
pnpm exec vue-doctor ci install --fail-on warning --force
```

The generated workflow gates on errors and incomplete coverage by default.

The workflow runs the project's installed Vue Doctor executable (or Yarn's local executable resolution); it never downloads a CLI by registry name. Make this distribution available through a reproducible workspace or artifact dependency before enabling CI. Developer-machine links from the quick start are not portable to hosted runners.

## Changed-file scans

Limit a run to git-changed files (useful in PRs):

```bash
vue-doctor --changed
vue-doctor --changed --changed-base origin/main
vue-doctor --changed --fail-on error --json
```

Changed files are intersected with the effective scope: explicit `--scope` takes precedence over the project's configured scope. The executable config is loaded once per run. Git paths are resolved relative to the repository root and then restricted to the consuming project, including monorepo subprojects. An empty changed-file set still produces a fresh report for `--json`, `--json-out` and Inspector. Missing or unreadable scan paths appear in `coverage.source.discoveryIssues` and make source coverage partial; a valid empty target set is complete. The generated CI workflow uses an explicit PR base for merge-base comparison and performs a full scan on push.

## Local suppression with audit

Suppress one specific rule on the directive line or the following line, with a required reason:

```ts
// vue-doctor-disable-next-line vue-shallow-ref-nested-mutation -- Reviewed replacement flow
state.value.count++
state.value.count++ // vue-doctor-disable-line vue-shallow-ref-nested-mutation -- Reviewed replacement flow
```

Use actual script, template/HTML or CSS-family comments; text inside strings has no effect. For a multiline comment, `disable-next-line` targets the line after the comment ends. File-wide suppression and wildcard codes are unsupported. Invalid, unknown and unused directives remain in `suppressionAudit`; applied entries retain the original diagnostic, ID, location and reason. Suppression removes matching findings from active diagnostics and severity gates. It does not change execution records, required skips, run status or incomplete-coverage gates. Inspector's Audit view exposes the audit.
