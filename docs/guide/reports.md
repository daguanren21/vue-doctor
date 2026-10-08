# Reports and coverage

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./reports.zh-CN.md)

## JavaScript API

The public facade returns the same report as the CLI and Vite integration:

```ts
import { runDoctor } from 'vue-doctor'

const report = await runDoctor()
```

`runDoctor()` uses the current directory by default. Pass `{ root }` or `{ scope }` when an integration needs an explicit project location or source subpath. An optional `{ files }` allowlist further restricts source files within the effective scope; paths may be root-relative or absolute, and `files: []` produces a fresh zero-target report. Invalid scope or target paths remain coverage issues, including when the target list is empty.

Diagnostic targets are separate from `projectContext`. A scoped scan still reads relevant application entries and registrations outside its target set. Inventory resolves packages from each consuming package location, including parent installations and npm aliases. Vue versions and plugin registrations stay associated with their package and application. Unresolved application ownership is recorded in `coverage.source.contextIssues` when it affects component analysis.

## JSON reports

For command-line automation, print JSON to stdout or write it to a file:

```bash
vue-doctor --json
vue-doctor --json-out .vue-doctor/report.json
```

Both forms use the shared `DoctorReport` model:
```json
{
  "schemaVersion": 1,
  "run": {
    "status": "complete",
    "target": { "mode": "project", "scopes": [], "files": [] }
  },
  "project": {
    "root": "/path/to/project",
    "vueFramework": "vue3",
    "uiLibraries": ["element-plus"]
  },
  "inventory": { "root": "/path/to/project", "packages": {} },
  "coverage": {
    "status": "complete",
    "source": { "status": "complete", "scannedFileCount": 0, "failedFiles": [] },
    "componentLibraries": []
  },
  "diagnostics": [],
  "checks": [],
  "suppressionAudit": []
}
```

New reports use schema version 1. Unversioned reports are legacy v0; the Inspector rejects unsupported future versions. `diagnostics[].id` is a `vd1:` fingerprint of normalized finding facts, independent of checkout directory, Git attribution, severity policy and ordering. Source or evidence changes can change the ID. `primaryLocation` declares `file`, `line`, `point` or `range` precision: present lines and columns are one-based and range ends are exclusive. Missing columns remain unknown. `fixes` contains remediation suggestions (`kind: 'suggestion'`); separate optional `edits` contains explicit text edits. The Inspector previews these fields without applying them.

Optional `ruleCatalogs` contains serializable rule metadata discovered during the run, including project ESLint rules that produced no findings. It does not contain executable plugins or rule functions. `rulePacks` remains the metadata and execution report for explicitly enabled external packs.

## Diagnostics and coverage

Reports add `diagnostics[].domain`, `tags`, `rulePack`, and `domainCoverage`. The domains are component-library contracts, CSS/styles, interaction, Vue syntax/API, Vite, and conventions; rules without domain metadata remain unclassified. A finding has one primary domain and is counted once, even when its tags cross domains. Inspector groups findings by domain and lets you search tags or follow them from the Rule tab.

Domain coverage distinguishes `not-covered`, `not-reported`, `partial`, and `complete`. Rule counts describe registered definitions. Vite is explicitly not covered until a Vite rule pack is present; detecting the installed Vite version alone is not a completed Vite check. Top-level `checks` records built-in and external rule execution, including disabled, not-applicable, missing evidence and partial execution. Unknown Vue versions and failed source blocks carry explicit reasons; manual/runtime/policy acceptance remains pending. `rulePacks` continues to describe explicitly enabled external packs only. Unknown configured rule codes stop the run as configuration errors, including codes configured as `off`.

Vue API checks follow imports from `vue`, including named aliases and namespaces, and respect lexical shadowing. Compiler macros are recognized only in unshadowed `<script setup>` usage. Bare names supplied by automatic imports need explicit integration evidence; names alone do not prove a Vue API call.

Missing events, slots and model events are rejected only when the relevant acceptance boundary is proven closed. Open boundaries are accepted; unknown or conflicting boundaries create required skipped checks. Event handlers may take fewer parameters or rename/ignore them. Payload diagnostics require a complete signature and fire only when every overload supplies fewer arguments than the handler requires; optional and rest parameters are retained.

`diagnostics` contains supported findings about detected component usage, such as an unsupported prop, event, slot, or `v-model`, or an incompatible event payload. Each diagnostic carries a code, severity, confidence, evidence, and suggested fixes.
An absent prop is reported as unsupported only when both the component prop boundary and Vue attribute fallthrough are proven closed. `$attrs` is treated as a forwarding edge, so Vue Doctor follows it into the receiving component and requires that component to declare or safely forward the concrete attribute. A native root is accepted only when installed DOM type evidence supports the attribute. Unresolved forwarding remains partial coverage instead of flooding the default report; opt into per-usage info diagnostics with `rules['component-attribute-unverified'] = 'info'`.

`coverage` describes how much Vue Doctor could establish. Its overall status is `complete`, `partial`, or `blocked`; it also records source scan coverage and per-library contract coverage. Missing or incomplete contract knowledge belongs in each affected library's `coverage.componentLibraries[].problems`, not in `diagnostics`, because absence of evidence is not evidence that application code is wrong.

This separation lets automation distinguish “a problem was found” from “the check could not fully know.”

## Contract evidence sources

Vue Doctor first uses component metadata published with installed packages, including `web-types` and Vetur metadata. TypeScript declaration files supplement that evidence and can provide component contracts when metadata is empty or leaves a contract dimension unknown.

Per-library `coverage.componentLibraries[].contractSources` records where contract knowledge came from, such as an adapter, `web-types`, Vetur metadata, or TypeScript declarations, together with the relevant evidence location. Consumers can therefore see both the conclusion and its provenance.

## When a run is clean

A run is clean only when both conditions are true:

1. `diagnostics` is empty.
2. `coverage.status` is `complete`.

Zero diagnostics with `partial` or `blocked` coverage means only that Vue Doctor found no problems within the evidence it could analyze. CI and agents should report that state as incomplete, not clean.
