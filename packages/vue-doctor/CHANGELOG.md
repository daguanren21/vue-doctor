# @daguanren21/vue-doctor

## Unreleased

### Maintenance

- Route subsequent releases through repoctl 6.3.0 and GitHub Actions npm Trusted Publishing (OIDC), retaining a single public package and the public-workspace verification gate.
- Reject incompatible release dry-run modes before preparation so preview inputs cannot bypass release checks.
- Include Inspector coverage components in clean source checkouts by ignoring only generated root coverage reports.
- Defer skill-installer loading until a skill operation is requested, keeping its configuration parsers off diagnostic startup.
- Reuse immutable TypeScript library reference metadata and omit unused SFC source maps while preserving per-expression scopes, type/value references and source locations.
- Evaluate rule applicability once per distinct owning Vue version without changing package overrides, unavailable checks or source coverage.
- Keep declaration-cache isolation and invalidation tests on real persistent fixtures without redundant repeated reads or increased timeouts.
- Run the public-workspace verification gate on pull requests with read-only GitHub permissions before release integration.

## 0.1.0

### Minor Changes

- Initial public release under the `@daguanren21` scope, providing the Vue Doctor CLI, component-library diagnostics, custom rule APIs, Inspector, MCP server and build-tool integrations.
- Distribute one public package with built-in rules, Inspector assets, real source workers, skill assets and facade JavaScript/type exports bundled; internal workspace packages are not required as separate npm installs.
- Document global CLI installation, reusable `defineRule` authoring, Inspector integration and MCP client setup with concise runnable examples.

### Patch Changes

- Resolve the CLI runtime from the physical package location so scoped pnpm installations work with `--preserve-symlinks-main`.
- Build and release with Node 26.12.1, pnpm 12.15.0 and repoctl 6.1.0; retain a version-pinned development-tool patch for pnpm runtime lock entries without ignoring dependency mismatches.
- Support Node.js `^22.18.0 || >=24.11.0` and keep the TypeScript 6 parser and aliased native TypeScript 7 compiler isolated in the single-package dependency graph.
- Isolate platform-specific factory declarations from unrelated build hosts while preserving the shared plugin instance and canonical options.
- Include linked guides and complete Lucide/Feather license notices; disable inherited publication sourcemaps that cannot provide self-contained source navigation.
