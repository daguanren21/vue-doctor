# Vue Doctor Agent Instructions

## Project Scope

Vue Doctor is a diagnostics system for Vue, Vite, Nuxt, and Vue component-library usage. Keep user-facing documentation focused on product usage and integration. Keep agent workflow instructions in skills. Keep repository implementation constraints in this file.

## Dependency Constraints

- When adding or updating npm dependencies in this repository, use the latest available package versions.
- For interchangeable third-party npm packages, choose by npm weekly downloads first.
- Use GitHub stars as the secondary signal after npm downloads.
- First-party or ecosystem-standard packages may override popularity ranking when they are the factual source for the job.
- Explicit project convention: CLI command parsing uses `cac`.
- Explicit project convention: package builds use `tsdown`; do not introduce `tsup`.
- Host project packages such as `vue`, `vite`, `@vitejs/plugin-vue`, `@vitejs/plugin-vue2`, Nuxt, and component libraries should be detected from consuming projects. Do not present them as required business install steps unless scaffolding a fixture or development workspace.

## Architecture Constraints

- Use a pnpm monorepo.
- Keep Doctor Run and inventory logic in `@vue-doctor/core`.
- Keep component-library package evidence extraction in `@vue-doctor/component-library`.
- Keep consuming project source usage extraction in `@vue-doctor/source`.
- Keep component-library diagnostics rules in `@vue-doctor/rule-pack-component-library`.
- Keep default Doctor Run composition in `@vue-doctor/runner`.
- Keep host integrations such as Vite plugin behavior outside core packages.
- Keep the public `vue-doctor` package as CLI and facade exports only.
- Split future rule packs, component-library adapters, and inspector UI into separate workspace packages.

## Documentation Boundaries

- Do not put dependency-selection policy in `README.md` or `README.zh-CN.md`.
- Do not put Vue Doctor repository implementation constraints in the reusable `skills/vue-doctor/SKILL.md`.
- README files should explain product behavior, CLI usage, plugin integration, Inspector behavior, report shape, and component-library diagnosis concepts.
- The Vue Doctor skill should explain how an agent diagnoses consuming Vue projects from installed package evidence.

## Public Distribution Boundary

- Keep organization-specific rule implementations, UI bindings, source snapshots, internal identifiers, and real project paths out of public distributions.
- Preserve private extensions locally or in a separate private repository; do not disguise their implementation by renaming it and publishing it.
- Public examples must use public ecosystems or synthetic fixtures and the documented extension APIs.
- Before publishing, inspect file paths, source content, manifests, lockfiles, generated package archives, and commit metadata for private material.
- Validate the exact public workspace without relying on excluded private packages or local caches.
- Workspace packages must explicitly allowlist runtime files for packaging; do not ship source tests, compiler caches, or local analysis output.
