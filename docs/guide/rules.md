# Rules and Vue version support

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./rules.zh-CN.md)

## Built-in rule selection

Vue diagnostics and the Vite host integration are built in. Official ESLint core rules are registered as `eslint/<rule-name>` and can be enabled explicitly:

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  eslint: { mode: 'builtin' },
  rules: { 'eslint/no-debugger': 'error', 'eslint/eqeqeq': 'warning' }
})
```

ESLint delegates default to disabled. Use `vue-doctor rules list` or `vue-doctor rules explain eslint/no-debugger` to inspect them. Detecting a Vite version does not establish Vite diagnostic coverage; coverage comes from rules that actually execute.

## Vue migration and correctness checks

Vue adds APIs across minor versions. Older patterns can still compile, so a build may not flag a migration opportunity. Vue Doctor gates migration hints by the installed Vue version.

For example, Vue 3.5 introduced [`useTemplateRef()`](https://vuejs.org/guide/essentials/template-refs.html#accessing-the-refs). A template ref declared with `ref(null)` still works:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'

const input = ref<HTMLInputElement | null>(null)

onMounted(() => input.value?.focus())
</script>

<template>
  <input ref="input">
</template>
```

On Vue 3.5+, Vue Doctor can recommend the version-aware form:

```vue
<script setup lang="ts">
import { onMounted, useTemplateRef } from 'vue'

const input = useTemplateRef('input')

onMounted(() => input.value?.focus())
</script>

<template>
  <input ref="input">
</template>
```

The template key is explicit in source, and Vue's IDE support and `vue-tsc` can infer `input.value` from the matched element or component.

Enable opt-in modernization hints when `eslint-plugin-vue` is not already reporting the same migration:

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  rules: {
    'vue-prefer-use-template-ref': 'info',
    'vue-prefer-define-model': 'info'
  }
})
```

Migration and correctness guidance is broader than template refs:

- Replace prop plus `update:*` boilerplate with `defineModel()` when the target is Vue 3.4+.
- Replace watcher-maintained derived state with `computed()`.
- Replace `watch(state.count, ...)` snapshots with a getter such as `watch(() => state.count, ...)`.
- Register watcher cancellation and resource cleanup before async work can become stale.
- Replace or explicitly trigger nested `shallowRef` state; do not assume a deep mutation is reactive.
- Keep `reactive()` proxy identity stable instead of reassigning the binding.
- Use `toRefs()` only with a reactive object, and do not return long-lived `toRaw()` references.
- Stop detached `effectScope()` instances and avoid reusing a stopped scope.
- Keep `useTemplateRef()` keys aligned with the template and let Vue own the readonly ref value.
- Gate `watch` options, watcher/scope pause-resume, `onWatcherCleanup()`, `useId()`, `useTemplateRef()`, `defineModel()`, and App APIs by the installed Vue minor.
- Check component-library props, events, slots, `v-model`, fallthrough, and event payloads against the installed package version.

Rules that overlap with `eslint-plugin-vue` remain opt-in. Doctor-specific compatibility, package-contract, watcher, lifecycle, reactivity, and coverage checks stay enabled by default.

## ESLint and Doctor rule ownership

With a project `eslint.config.*`, Doctor uses that project's ESLint and configuration. Preset imports, local plugins, rule options, ignores and file overrides remain owned by the project. Without a config, or in `eslint.mode: 'builtin'`, Doctor uses its isolated opt-in delegates. See [project ESLint configuration](./configuration.md#project-eslint) for mode selection.

Keep `eslint-plugin-vue` for fast single-file syntax and style checks. Vue Doctor's differentiated checks use evidence that a normal ESLint rule does not own: the consuming project's installed Vue minor version, package inventory, global plugin registration, import aliases, component contracts, runtime fallthrough, and cross-file ownership. This is why Vue Doctor can validate an installed UI library's props, events, slots, and `v-model` while also reporting when the available evidence is incomplete.

Rules that duplicate `eslint-plugin-vue` syntax or style checks are opt-in in the default Doctor Run. Set an explicit severity in `rules` to enable one. Doctor-specific API checks remain enabled across `watch()` source validity, self-mutating and stale async watchers, watcher cleanup, async `watchEffect` tracking, derived state, `ref`/`shallowRef`, `reactive`/`shallowReactive`, readonly proxies, detached `effectScope`, `customRef`, `toRefs`, SSR setup, lifecycle behavior, and version-gated Vue APIs.

Vue-version-specific diagnostics are gated by the target project: Vue 2.7 keeps valid `.sync`, `.native`, and filter syntax, while Vue 3 diagnostics are enabled only at the minor version that introduced or removed the relevant API. Vue versions below 2.7 and future unsupported majors are reported as `unsupported` rather than treated as Vue 3.

The version matrix covers Vue 2.7 observer and reactive-target limits, async `setup()`, and async-component differences; Vue 3 app/setup context and readonly-computed contracts; Vue 3.4 watcher `once` and model APIs; and Vue 3.5 numeric deep watchers, watcher/scope pause-resume, `onWatcherCleanup()`, `useId()`, `useTemplateRef()`, and `app.onUnmount()`. Unsupported options are reported as runtime compatibility problems rather than silently interpreted as the latest Vue behavior.
