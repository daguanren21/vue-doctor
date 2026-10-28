# @daguanren21/vue-doctor-source

## 0.1.0

### Minor Changes

- Initial public release under the `@daguanren21` scope, providing the Vue Doctor CLI, component-library diagnostics, custom rule APIs, Inspector, MCP server and build-tool integrations.

### Patch Changes

- Correct JavaScript loop-write and iterator-alias invalidation, parameter-default scopes, Vue 2/3 application receiver tracking (including tagged-template escapes), and SFC parser error locations.
- Align the public TypeScript parser dependency with the ESLint bridge and invalidate earlier cached source facts.
- Record proven template exposure for imports and static Options registrations without borrowing shadowed bindings or uncertain overrides.
- Load the existing TypeScript CommonJS API without redundant ESM format detection.
- Limit namespace-member template origins to proven script-setup exposure; Options registrations expose their registered component name, not arbitrary members.
