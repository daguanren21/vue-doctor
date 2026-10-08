# 规则与 Vue 版本支持

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./rules.md)

## 选择内置规则

Vue 诊断和 Vite 宿主集成直接内置。官方 ESLint core 规则也已注册为 `eslint/<规则名>`，通过配置显式开启：

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  eslint: { mode: 'builtin' },
  rules: { 'eslint/no-debugger': 'error', 'eslint/eqeqeq': 'warning' }
})
```

ESLint 规则默认关闭。`vue-doctor rules list` 和 `vue-doctor rules explain eslint/no-debugger` 可查看内置规则。检测到 Vite 版本不会自动算作 Vite 诊断覆盖；覆盖率只来自实际执行的规则。

## Vue 迁移与正确性检查

Vue 小版本持续增加新 API。旧写法往往还能编译，build 不会提醒团队更新。Vue Doctor 按项目实际安装的 Vue 版本给出迁移建议。

Vue 3.5 增加了 [`useTemplateRef()`](https://vuejs.org/guide/essentials/template-refs.html#accessing-the-refs)。以前用 `ref(null)` 保存 DOM 引用仍然可以运行：

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

项目使用 Vue 3.5+ 时，Vue Doctor 可以提醒改成按 template key 绑定的写法：

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

template key 会明确写在源码里，Vue 的 IDE 支持和 `vue-tsc` 还能根据匹配的元素或组件推断 `input.value` 类型。

如果 `eslint-plugin-vue` 没有报告同类迁移，可以按需开启 modernization hint：

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  rules: {
    'vue-prefer-use-template-ref': 'info',
    'vue-prefer-define-model': 'info'
  }
})
```

当前迁移与正确性提醒还覆盖：

- Vue 3.4+ 用 `defineModel()` 收拢 prop 与 `update:*` event 声明。
- watcher 维护派生状态时改用 `computed()`。
- `watch(state.count, ...)` 传入的是快照，改成 `watch(() => state.count, ...)`。
- 异步 watcher 在旧请求失效前注册 cancellation 和 cleanup。
- `shallowRef` 的深层 mutation 不会自动触发更新，需要替换 `.value` 或显式 `triggerRef()`。
- 保留 `reactive()` proxy identity，避免重新赋值后让旧消费者继续持有失效 proxy。
- `toRefs()` 只接收 reactive object；`toRaw()` 的结果不应作为长期引用返回。
- detached `effectScope()` 需要 stop，已经 stop 的 scope 不能继续 run。
- `useTemplateRef()` 的 key 要和 template 一致，返回的 readonly ref 由 Vue 更新。
- `watch` option、watcher/scope pause-resume、`onWatcherCleanup()`、`useId()`、`useTemplateRef()`、`defineModel()` 和 App API 按 Vue 小版本检查。
- UI 组件的 prop、event、slot、`v-model`、attribute fallthrough 和 event payload 按实际安装的 package 版本检查。

与 `eslint-plugin-vue` 重复的源码风格规则默认不启用。Vue Doctor 自己负责的版本兼容、package contract、watcher、生命周期、reactivity 和 coverage 检查默认开启。

## ESLint 与 Doctor 的规则分工

项目有 `eslint.config.*` 时，Doctor 使用该项目安装的 ESLint 和配置，preset import、本地插件、规则 options、ignore 和文件覆盖均由项目管理。没有配置或使用 `eslint.mode: 'builtin'` 时，Doctor 才使用独立的可选委托规则。模式选择见[项目 ESLint 配置](./configuration.zh-CN.md#项目-eslint)。

继续使用 `eslint-plugin-vue` 完成快速的单文件语法和风格检查。Doctor Run 读取消费项目实际安装的 Vue 小版本、package inventory、全局 plugin 注册、import alias、组件 contract、运行时 attribute 透传和跨文件归属。借助这些证据，Vue Doctor 能校验已安装 UI 框架的 props、events、slots 与 `v-model`，证据不足时则报告 coverage 不完整。

与 `eslint-plugin-vue` 重复的单文件语法或风格规则在默认 Doctor Run 中不启用；在 `rules` 中显式配置 severity 才会开启。Doctor 专属 API 检查一次覆盖 `watch()` source、自修改与陈旧异步写入、watcher cleanup、异步 `watchEffect`、派生状态、`ref`/`shallowRef`、`reactive`/`shallowReactive`、readonly proxy、detached `effectScope`、`customRef`、`toRefs`、SSR setup、生命周期和按版本启用的 Vue API。

版本相关诊断按目标项目启用：Vue 2.7 保留合法的 `.sync`、`.native` 和 filter 语法；Vue 3 规则只在相关 API 引入或移除的小版本生效。低于 2.7 的 Vue 2 以及未来尚未支持的 major 会报告为 `unsupported`，不会被当作 Vue 3。

当前版本矩阵覆盖 Vue 2.7 的 observer 与 reactive target 限制、异步 `setup()` 和异步组件差异；Vue 3 的 App/setup context 与 readonly computed 契约；Vue 3.4 的 watcher `once` 和 model API；以及 Vue 3.5 的数值 `deep`、watcher/scope pause-resume、`onWatcherCleanup()`、`useId()`、`useTemplateRef()` 和 `app.onUnmount()`。不受目标运行时支持的选项会按兼容性问题报告，不会静默套用最新 Vue 的语义。
