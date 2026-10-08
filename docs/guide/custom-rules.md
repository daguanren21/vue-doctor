# Custom AST rules

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./custom-rules.zh-CN.md)

## Define and export a pack

The following two files form a runnable local pack. With `vue-doctor` available to your project, save the rule module as `doctor-rules.ts`. Import the public authoring helpers from `vue-doctor/rules`; no internal package paths or additional parser installation are needed for this Oxc example.

```ts
import { defineRule, defineRules, oxcRule } from 'vue-doctor/rules'

export const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: {
        title: 'Use block-scoped declarations',
        description: 'Choose let or const instead of var.',
        domain: 'conventions',
        defaultSeverity: 'warning'
      },
      check: oxcRule({
        create(context) {
          return {
            VariableDeclaration(node) {
              if (node.kind === 'var') {
                context.report({ node, message: 'Use let or const.' })
              }
            }
          }
        }
      })
    }),
    'no-debugger': defineRule({
      meta: {
        title: 'Remove debugger statements',
        description: 'Do not commit debugger statements.',
        domain: 'conventions',
        defaultSeverity: 'error'
      },
      check: oxcRule({
        create(context) {
          return {
            DebuggerStatement(node) {
              context.report({ node, message: 'Remove this debugger statement.' })
            }
          }
        }
      })
    })
  }
})
```

## Import and register the pack

Save this executable configuration as `doctor.config.ts` beside the module:

```ts
import { defineDoctorConfig } from 'vue-doctor'
import { teamRules } from './doctor-rules.ts'

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: {
    'team/no-var': 'warning',
    'team/no-debugger': 'error'
  }
})
```

`defineRule` defines each check; `oxcRule` supplies its script AST visitor; `defineRules` combines the checks into one exported pack. The pack name and rule keys produce `team/no-var` and `team/no-debugger`. Use those full codes in `rules` to choose `error`, `warning`, `info`, or `off`. Custom rules use the normal rule catalog, suppression audit, and coverage gates. An unknown rule code in `config.rules` is a configuration error, even when its severity is `off`.

For shared use, export `teamRules` from your package's public entry point and import that export in the consuming project's config instead of the relative module. Keep `vue-doctor` available to the consumer and declare it as a compatible peer dependency of a reusable rule package. Use the documented `vue-doctor/rules` entry point rather than workspace source paths. Doctor does not install or download rule packs: the package must already be resolvable from the project.

Configuration and imported packs are trusted executable code. JSON configuration cannot import rule functions. Register each imported pack in `rulePacks`; importing a module alone does not enable it. An inline API `rulePacks` list replaces the file-configured list; `[]` disables external packs.

Keep private policies outside the public repository, for example in a separately distributed private package or an external local module. If stored inside a checkout, keep both the policy module and any private config untracked and ignored locally (for example through `.git/info/exclude`). Ignoring a previously tracked file does not remove it from publication or history. Publish only the neutral example, never credentials, private package names or internal paths.

## Exercise both checks

Create `src/rule-demo.ts` in a scratch consumer project:

```ts
var attempts = 0
debugger
export { attempts }
```

Then run:

```bash
./node_modules/.bin/vue-doctor --config ./doctor.config.ts --scope src/rule-demo.ts --json
pnpm exec vue-doctor rules explain team/no-debugger --config ./doctor.config.ts
```

The sample should produce a `team/no-var` warning and a `team/no-debugger` error with source locations. Other enabled checks may also report findings or coverage gaps. Replace `var` with `let` and remove `debugger` to address these two findings; that alone does not prove overall coverage complete. These are small teaching rules; use existing ESLint rules instead when they already meet your requirements.

## Parser backends and evidence

`oxcRule` uses Oxc's ESTree/TS-ESTree nodes. Visitor keys are node names such as `VariableDeclaration`, with `VariableDeclaration:exit` for leaving a node; match additional conditions inside the callback. Arbitrary ESLint selector strings are not supported by this adapter. JS, TS, JSX, TSX and inline Vue script blocks are supported. `context.text(node)` reads the original block text; `context.location(node)` maps UTF-16 offsets to the complete source file with one-based lines and columns. AST changes are local to the current rule and do not edit project files or propagate to other rules.

Use `babelRule` for Babel syntax plugins or native Babel visitors: callbacks receive `NodePath`, and `path.scope.getBinding(name)` resolves lexical bindings. Declare `requires: { scope: true }` when needed, and enable additional syntax through `parserOptions.plugins`. Babel nodes and Oxc nodes have different structures. Each inline Vue script block has its own traversal and lexical scope. The Babel backend requires Node `^22.18.0 || >=24.11.0` and loads only when selected; Oxc rules retain Vue Doctor's existing Node support.

The `requires` capability flags are `syntax`, `scope`, and `types`. Oxc supplies syntax; Babel supplies syntax and lexical scope. Neither adapter supplies a TypeScript project checker: requesting `types` records a required capability gap. Existing template and type-aware rule packs continue to use their dedicated engines. Parser choice is explicit, and syntax errors do not automatically switch parsers. Missing source, external script blocks, unsupported languages, parsing failures, and rule callback failures produce required skips and incomplete coverage.

Rule metadata can also declare `meta.requires` for source blocks and Vue-version evidence. Component ownership and contract evidence requirements are unavailable to this script adapter and produce required skips. Rules marked `manual`, `runtime`, or `policy-pending` retain those verification states; an AST traversal cannot complete their acceptance checks.

For ESLint selectors, comments, lexical scope, Vue template parser services or project types, use the ESTree adapter from `vue-doctor/rules-eslint`:

```ts
import { defineRule, defineRules } from 'vue-doctor/rules'
import { estreeRule } from 'vue-doctor/rules-eslint'

const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: { title: 'Use block-scoped declarations', description: 'Choose let or const.' },
      check: estreeRule({
        meta: { schema: [] },
        create(context) {
          return {
            'VariableDeclaration[kind="var"]'(node) {
              context.report({ node, message: 'Use let or const.' })
            }
          }
        }
      })
    })
  }
})
```

`eslintRule({ module, options, typed: true })` accepts official RuleModules or checks requiring a real consumer TypeScript program and node maps. Typed checks require the project's `tsconfig.json` or `jsconfig.json`. Vue template services use the `vue-eslint-parser` AST; Vue compiler-sfc extracts the SFC descriptor and original script text. This path retains the Node 20 baseline and Vue 2.7/3 support.

The same ESLint engine batches independently registered rules, using at most one ordinary pass and one typed pass per document. ESTree checks share that pass's parser context and should treat the AST as read-only; Oxc/Babel checks still receive independent AST copies. Graph analysis, original-byte checks and other parsers can use `defineRuleEngine` and `engineRule` with the same `defineRules` API. Each rule must return an execution record; exceptions, missing records and invalid outputs produce required skips.
