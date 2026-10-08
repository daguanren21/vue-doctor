# Vue Doctor diagnostic packs

Use `pnpm exec vue-doctor rules list` for the local installation's live catalog. Use `rules explain <code>` before changing app code or config.

## How to use a code from report.json

Every `diagnostics[]` item has:

- `code`
- `severity`
- `confidence`
- `message`
- `file`
- `evidence[]`
- `fixes[]`

Workflow:

1. Take `code` from the report
2. Run `rules explain <code>`
3. Open `file` + evidence locations
4. Apply the smallest owning fix
5. Re-scan to a new report and diff codes

## Packs

### `vue`

Source/template/script diagnostics about the consuming app.

Common families:

- security: `vue-security-restrict-v-html`
- template structure: `vue-template-v-for-key`, `vue-template-v-if-for`, `vue-template-shadow`
- props/reactivity: `vue-prop-mutated`, `vue-ref-as-operand`, `vue-setup-props-destructure`
- lifecycle/watch cleanup: `vue-lifecycle-require-cleanup`, `vue-watch-require-cleanup`
- style suggestions (often noisy): `vue-prefer-use-template-ref`, `vue-prefer-define-model`

If the required template/script block failed to parse, expect required skipped checks instead of fake diagnostics.

### `component-library`

Installed package contract diagnostics.

Common codes:

- unsupported API: `component-prop-unsupported`, `component-event-unsupported`, `component-slot-unsupported`, `component-model-unsupported`
- required/type: `component-prop-required-missing`, `component-prop-type-mismatch`
- payload change: `component-event-payload-changed`
- unresolved evidence: `component-attribute-unverified` (info; not proven unsupported)

Only treat closed-boundary unsupported findings as confirmed API bugs. Keep unresolved forwarding/coverage gaps separate.

## Severity handling

| Severity | Default agent action |
| --- | --- |
| `error` | Fix or justify with evidence |
| `warning` | Fix when in scope |
| `info` | Keep unless cleanup requested or evidence becomes decisive |

## Clean vs incomplete

- Clean: no diagnostics + complete coverage + no required skipped checks
- Incomplete: partial/blocked coverage or required skipped checks, even if diagnostics is empty
