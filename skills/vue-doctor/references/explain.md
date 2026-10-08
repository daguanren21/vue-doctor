# Explaining and configuring Vue Doctor rules

Use this when the user wants to understand a diagnostic code or change which rules run — not for fixing application code.

Triggers: "why did this fire", "I disagree", "turn this off", "too noisy", "disable style suggestions".

## Workflow

1. Identify the diagnostic `code` from an MCP finding, `.vue-doctor/report.json`, or CLI output.
2. Explain it before changing anything:

```bash
pnpm exec vue-doctor rules explain component-prop-unsupported
```

3. Pick the narrowest control.
4. Edit `doctor.config.*` or `package.json#vueDoctor`.
5. Validate with an explicit MCP rescan of the same project and scope, or a fresh CLI report:

```bash
pnpm exec vue-doctor --json-out .vue-doctor/report.json
```

## Commands

```bash
pnpm exec vue-doctor rules list
pnpm exec vue-doctor rules list vue
pnpm exec vue-doctor rules list component-library
pnpm exec vue-doctor rules explain <code>
```

## Decision guide

Prefer the narrowest control:

- **One false positive / disagree with one code** → set that code to `"off"`
- **Severity is wrong** → set `"error"` | `"warning"` | `"info"`
- **Need CI gating** → set `failOn` / `failOnIncompleteCoverage` or pass CLI flags
- **Need narrower scans** → use `scope`, `--changed`, or config `scope`

Do **not** disable a rule just to make the report quieter if the finding is real.

## Config shape

Config files (first match wins):

- `doctor.config.json` / `doctor.config.js` / `doctor.config.mjs` / `doctor.config.ts`
- `vue-doctor.config.*`
- `package.json#vueDoctor`

```json
{
  "scope": "src",
  "rules": {
    "vue-prefer-use-template-ref": "off",
    "component-prop-type-mismatch": "error"
  },
  "failOn": "error",
  "failOnIncompleteCoverage": true
}
```

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  rules: {
    'vue-prefer-define-model': 'off'
  },
  failOn: 'error'
})
```

CLI overrides:

```bash
pnpm exec vue-doctor --fail-on error
pnpm exec vue-doctor --fail-on-incomplete-coverage
pnpm exec vue-doctor --config ./doctor.config.json
```

## Educating the user

Lead with the problem/remediation from `rules explain`. Offer disable only after the user understands the finding. Many noisy-looking codes are still real contract or security issues.
