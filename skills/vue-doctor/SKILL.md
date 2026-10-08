---
name: vue-doctor
description: Use when finishing Vue changes, fixing a Vue bug, before committing Vue code, or when the user types `/doctor`, asks to scan, triage, or clean up Vue Doctor diagnostics. Covers Vue source rules and component-library contract diagnostics. Work from structured MCP snapshots when connected, otherwise report.json.
metadata:
  version: "1.0.0"
---

# Vue Doctor

Diagnoses Vue projects from installed package evidence and source usage. Emits a structured `DoctorReport` for humans, CI, and agents.

## Choose the available evidence channel

When Vue Doctor MCP tools are connected, follow [references/mcp.md](references/mcp.md). Select the intended project, read help and overview, then query the completed snapshot. Avoid starting a second CLI analysis for the same triage.

When MCP is unavailable, use the CLI/report workflow below. A JSON report is also useful when the user needs a complete saved artifact.

Use the consuming project's trusted Vue Doctor installation or local link. The commands below run that local executable with `pnpm exec`; do not silently download a same-named registry package. If the tool is unavailable, follow the intended distribution's setup instructions before scanning.

## After making Vue code changes

For a connected MCP session, use the explicit rescan and verification workflow in [references/mcp.md](references/mcp.md). For CLI/report-based work:

1. Scan the changed surface and write a report:

```bash
pnpm exec vue-doctor --changed --json-out .vue-doctor/report.json
```

2. **Read `.vue-doctor/report.json` first.** Do not invent findings from memory or freeform CLI text.
3. Fix only confirmed `diagnostics` that your change owns.
4. Re-run the same command and compare the new report to the previous one.
5. Stop only when the intended codes are gone, no new high-confidence findings appeared, and `coverage.status` did not regress.

If `--changed` is unavailable or too broad, use:

```bash
pnpm exec vue-doctor --scope <path> --json-out .vue-doctor/report.json
```

## For general cleanup or full triage

When the user types `/doctor`, says "run vue doctor", or asks for a full cleanup:

Use [references/mcp.md](references/mcp.md) when Doctor MCP is available. Otherwise:

1. Follow [references/triage.md](references/triage.md) exactly.
2. Always start by writing and reading a report:

```bash
pnpm exec vue-doctor --json-out .vue-doctor/report.json
```

3. Work from that JSON: filter, triage, fix, validate.
4. Prefer interactive Inspector only after the report exists:

```bash
pnpm exec vue-doctor --inspect
```

## Configuring or explaining rules

When the user wants to understand a rule, disagrees with one, or wants to disable/tune rules (not fix code), read [references/explain.md](references/explain.md).

Start with:

```bash
pnpm exec vue-doctor rules explain <code>
```

Then apply the narrowest config change via `doctor.config.*` or `package.json#vueDoctor`.

## Command

```bash
pnpm exec vue-doctor --json-out .vue-doctor/report.json
```

| Flag / command | Purpose |
| --- | --- |
| `.` / `<path>` | Project root to scan |
| `--json-out <file>` | Write the structured Doctor report agents must use |
| `--json` | Print the structured report to stdout |
| `--changed` | Limit scan to git-changed files |
| `--scope <path>` | Limit scan to a project subpath |
| `--fail-on <level>` | CI gate: `error` \| `warning` \| `info` \| `never` |
| `--fail-on-incomplete-coverage` | Fail when coverage is not complete |
| `--inspect` | Open local Inspector for the current report |
| `mcp <root>` | Serve headless diagnostics over MCP stdio |
| `rules list` | List diagnostic codes by rule pack |
| `rules explain <code>` | Explain problem + remediation for one code |
| `ci install` | Scaffold GitHub Actions workflow |
| `install` | Install this skill into local coding agents |

## Evidence-first rules

- The structured report or its MCP snapshot is the source of truth: project, installed-package evidence, coverage, findings and skipped checks.
- Treat `diagnostics[]` as confirmed findings.
- Treat `coverage.status !== "complete"` and required `skippedChecks` as incomplete knowledge, not green.
- `component-attribute-unverified` is unresolved evidence, not proven unsupported API.
- Fix errors first, then warnings. Keep info unless stronger evidence closes it.
- Do not disable rules just to silence a report.
- Do not install Vue/Vite/Nuxt/component libraries as a normal diagnosis step.

## Minimal result contract

For each fixed issue, report from the before/after JSON or MCP snapshots:

```markdown
Code: <diagnostic.code>
Severity/confidence: <severity> / <confidence>
Source: <file:line>
Evidence: <evidence summary>
Coverage: <complete|partial|blocked>
Fix: <concrete change>
Validation: <command> ; before=<n> after=<n>
```
