# @daguanren21/vue-doctor-component-library

## 0.1.0

### Minor Changes

- Initial public release under the `@daguanren21` scope, providing the Vue Doctor CLI, component-library diagnostics, custom rule APIs, Inspector, MCP server and build-tool integrations.

### Patch Changes

- Keep independent component declarations separate, preserve mixed primitive literals and tuple payload semantics, and leave opaque metadata types unavailable.
- Reject malformed, sparse, missing-literal and non-finite-literal cached contract structures and invalidate older extraction facts.
- Resolve runtime contracts through canonical package and entry paths, preserve authored SFC prop constraints, and exclude compiler-resolution metadata from syntax traversal.
- Honor effective mixed-script macro props, including decorated TypeScript and explicit empty options; unavailable compilation no longer restores obsolete ordinary or inherited prop evidence.
- Updated dependencies:
  - @daguanren21/vue-doctor-core@0.1.0
