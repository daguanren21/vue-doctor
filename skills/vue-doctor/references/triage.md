# Vue Doctor Triage

Use this sequence for CLI/report-based Vue Doctor triage. For connected Doctor MCP tools, use [mcp.md](mcp.md). The structured report or its completed MCP snapshot is the source of truth.

## 1. Scan and save the report

Always write a report file before triage:

```bash
pnpm exec vue-doctor --json-out .vue-doctor/report.json
```

Narrow when possible:

```bash
pnpm exec vue-doctor --changed --json-out .vue-doctor/report.json
pnpm exec vue-doctor --scope src/features/account --json-out .vue-doctor/report.json
```

Then open `.vue-doctor/report.json` and work from it. Do not triage from remembered warnings or partial terminal text.

## 2. Read the report shape

| Field | Meaning |
| --- | --- |
| `project` | Root and detected Vue/Vite versions |
| `inventory` | Installed/declared packages |
| `coverage.status` | `complete` \| `partial` \| `blocked` |
| `coverage.source` | Source scan completeness |
| `coverage.componentLibraries` | Per-library contract completeness |
| `diagnostics` | Confirmed findings to fix or intentionally keep |
| `skippedChecks` | Checks that could not run; required ones block "clean" |

A run is clean only when:

1. `diagnostics` is empty
2. `coverage.status` is `complete`
3. no required skipped checks remain

Zero diagnostics with partial/blocked coverage means incomplete, not clean.

## 3. Filter

From the report, partition items:

1. **Must fix now**: `severity: "error"` diagnostics you can own
2. **Should fix**: high-confidence warnings in changed code
3. **Hold**: info / low-confidence / outside current scope
4. **Not bugs**: coverage problems, parse failures, unresolved forwarding (`component-attribute-unverified`)

Useful filters:

- by `severity`
- by `code`
- by package name inside `message`
- by `file`
- by rule pack prefix: `vue-*` vs `component-*`

For one code:

```bash
pnpm exec vue-doctor rules explain <code>
```

## 4. Triage each diagnostic from evidence in the report

For every selected diagnostic:

1. Read `code`, `severity`, `confidence`, `message`, `file`, `evidence`, `fixes`
2. Open the cited source location
3. If it is a component-library finding, inspect the installed package evidence named by the diagnostic/message
4. Choose the smallest owning fix:
   - business usage wrong → fix app code
   - library evidence incomplete but runtime supports it → fix library metadata/types/runtime evidence
   - Doctor false positive with repro → fix Doctor, do not silence the app

## 5. Fix order

1. Errors
2. Warnings that block the current change
3. Remaining warnings
4. Info only when the user asked for cleanup or evidence is now decisive

Do not translate React rules mechanically. Respect Vue template semantics, reactivity, props-down/events-up, and the installed Vue major.

## 6. Validate with a fresh report

Re-run the **same** scan command and write a new report:

```bash
pnpm exec vue-doctor --changed --json-out .vue-doctor/report.after.json
# or full:
pnpm exec vue-doctor --json-out .vue-doctor/report.after.json
```

Compare:

- intended codes removed
- no new high-confidence diagnostics introduced
- `coverage.status` not worse
- required skipped checks not increased

Optional interactive review after the JSON exists:

```bash
pnpm exec vue-doctor --inspect
```

## Stop conditions

Stop only when all are true:

- intended diagnostics are gone from the latest report
- no new high-confidence diagnostics appeared
- coverage did not regress
- remaining items are explicitly classified as hold/info/coverage gaps
