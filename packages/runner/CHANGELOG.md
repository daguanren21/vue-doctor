# @daguanren21/vue-doctor-runner

## 0.1.0

### Minor Changes

- Initial public release under the `@daguanren21` scope, providing the Vue Doctor CLI, component-library diagnostics, custom rule APIs, Inspector, MCP server and build-tool integrations.

### Patch Changes

- Require per-rule execution evidence for complete coverage and validate cached source facts before reuse.
- Invalidate source facts produced before the AST and evidence corrections.
- Keep proven Vue 3 builtins out of third-party library coverage while preserving component facts, ordinary unknown-component gaps, and owning-package version boundaries.
- Classify static `vue:` redirects by their effective builtin target without exempting unknown, empty or incorrectly cased targets.
- Updated dependencies:
  - @daguanren21/vue-doctor-component-library@0.1.0
  - @daguanren21/vue-doctor-core@0.1.0
  - @daguanren21/vue-doctor-rule-pack-component-library@0.1.0
  - @daguanren21/vue-doctor-rule-pack-eslint@0.1.0
  - @daguanren21/vue-doctor-rule-pack-vue@0.1.0
  - @daguanren21/vue-doctor-source@0.1.0
