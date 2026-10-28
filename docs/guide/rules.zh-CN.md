# 规则与 Vue 版本支持

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./rules.md)

## 选择内置规则

Vue 诊断和 Vite 宿主集成直接内置。官方 ESLint core 规则也已注册为 `eslint/<规则名>`，通过配置显式开启：

```ts
import { defineDoctorConfig } from '@daguanren21/vue-doctor'

export default defineDoctorConfig({
  eslint: { mode: 'builtin' },
  rules: { 'eslint/no-debugger': 'error', 'eslint/eqeqeq': 'warning' }
})
```

ESLint 规则默认关闭。`vue-doctor rules list` 和 `vue-doctor rules explain eslint/no-debugger` 可查看内置规则。检测到 Vite 版本不会自动算作 Vite 诊断覆盖；覆盖率只来自实际执行的规则。

独立的内置 ESLint engine 只在存在已选择且可执行的文档批次时初始化。完整官方规则目录仍可直接读取，无须提前加载每条实现；metadata 按固定 ESLint 版本预生成，实际安装版本不同时仍读取该版本的真实规则。消费项目 ESLint 的发现与配置验证行为不变。

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
import { defineDoctorConfig } from '@daguanren21/vue-doctor'

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

## 参考 Vue AI Skills 补充的检查

对照社区 [Vue AI Skills](https://github.com/vuejs-ai/skills)、现有 Doctor 覆盖和 Vue 官方契约，新增了五条可选 Vue 3 规则。不需要安装该 skill，也不会改变默认规则选择。

| 规则 | 检测内容 |
| --- | --- |
| `vue-computed-async-getter` | 已证明来自 Vue 的 `computed()` 使用了内联 async getter。 |
| `vue-computed-source-mutation` | getter 直接写入稳定的外部响应式状态，或对已证明的源数组原地 sort/reverse。 |
| `vue-event-passive-prevent` | 原生 HTML/SVG 监听器同时使用 `.passive` 和 `.prevent`。 |
| `vue-memo-invalid-dependencies` | Vue 3.2+ 的 `v-memo` 接收了字面量或对象表达式，而不是数组。 |
| `vue-transition-group-mode` | 静态 `TransitionGroup` 传入了非空、可静态确定的 `mode`，但该属性不能控制列表过渡顺序。 |

在消费项目配置中显式开启需要的规则：

```ts
import { defineDoctorConfig } from '@daguanren21/vue-doctor'

export default defineDoctorConfig({
  rules: {
    'vue-computed-async-getter': 'warning',
    'vue-computed-source-mutation': 'warning',
    'vue-event-passive-prevent': 'warning',
    'vue-memo-invalid-dependencies': 'error',
    'vue-transition-group-mode': 'warning'
  }
})
```

检查有明确边界：computed setter、generator getter 函数体、延后执行的嵌套函数、getter 内部状态和数组副本不算修改外部源；纯类型包装不会改变 binding identity。不推断间接 getter/helper、别名和类内部副作用，数组方法检查不代表全程序或逃逸安全分析。未知 memo 表达式不会被判错，`[]` 合法。原生事件检查排除自定义／动态组件和 VNode hook。Vue 2 或无法确认的版本证据不会开启这些 Vue 3 检查。

不会据此强制 Composition API、TypeScript、所有 primitive 都用 `shallowRef()`、组件大小阈值，或禁止 computed getter 参数。Vue 3.4 的 previous-value 参数仍然合法。语义依据见 Vue 官方的 [computed 纯函数要求](https://vuejs.org/guide/essentials/computed.html#getters-should-be-side-effect-free)、[事件修饰符](https://vuejs.org/guide/essentials/event-handling.html#event-modifiers)、[v-memo 契约](https://vuejs.org/api/built-in-directives.html#v-memo)和 [TransitionGroup 差异](https://vuejs.org/guide/built-ins/transition-group.html#differences-from-transition)。

## ESLint 与 Doctor 的规则分工

项目有 `eslint.config.*` 时，Doctor 使用该项目安装的 ESLint 和配置，preset import、本地插件、规则 options、ignore 和文件覆盖均由项目管理。没有配置或使用 `eslint.mode: 'builtin'` 时，Doctor 才使用独立的可选委托规则。模式选择见[项目 ESLint 配置](./configuration.zh-CN.md#项目-eslint)。

继续使用 `eslint-plugin-vue` 完成快速的单文件语法和风格检查。Doctor Run 读取消费项目实际安装的 Vue 小版本、package inventory、全局 plugin 注册、import alias、组件 contract、运行时 attribute 透传和跨文件归属。借助这些证据，Vue Doctor 能校验已安装 UI 框架的 props、events、slots 与 `v-model`，证据不足时则报告 coverage 不完整。

与 `eslint-plugin-vue` 重复的单文件语法或风格规则在默认 Doctor Run 中不启用；在 `rules` 中显式配置 severity 才会开启。Doctor 专属 API 检查一次覆盖 `watch()` source、自修改与陈旧异步写入、watcher cleanup、异步 `watchEffect`、派生状态、`ref`/`shallowRef`、`reactive`/`shallowReactive`、readonly proxy、detached `effectScope`、`customRef`、`toRefs`、SSR setup、生命周期和按版本启用的 Vue API。

版本相关诊断按目标项目启用：Vue 2.7 保留合法的 `.sync`、`.native` 和 filter 语法；Vue 3 规则只在相关 API 引入或移除的小版本生效。低于 2.7 的 Vue 2 以及未来尚未支持的 major 会报告为 `unsupported`，不会被当作 Vue 3。

当前版本矩阵覆盖 Vue 2.7 的 observer 与 reactive target 限制、异步 `setup()` 和异步组件差异；Vue 3 的 App/setup context 与 readonly computed 契约；Vue 3.4 的 watcher `once` 和 model API；以及 Vue 3.5 的数值 `deep`、watcher/scope pause-resume、`onWatcherCleanup()`、`useId()`、`useTemplateRef()` 和 `app.onUnmount()`。不受目标运行时支持的选项会按兼容性问题报告，不会静默套用最新 Vue 的语义。
