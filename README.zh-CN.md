# Vue Doctor

[English](./README.md)

根据项目实际安装的 Vue 版本与组件库契约，诊断 Vue 2.7 和 Vue 3 项目。通过 CLI、Inspector 或 MCP 查看诊断、源码证据和分析覆盖情况。

要求 **Node.js >= 20.19.0**。Vue、Vite、Nuxt 和 UI 库从项目中自动识别。

## 快速上手

先构建本仓库源码。目前 npm 上的无作用域同名包属于另一项目，请使用本仓库，不要安装该注册表包：

```bash
git clone https://github.com/daguanren21/vue-doctor.git
cd vue-doctor
pnpm install --frozen-lockfile
pnpm build
node packages/vue-doctor/dist/cli.mjs /path/to/your-project
```

诊断较多时按规则分组并列出代表位置。使用 `--verbose` 查看每条诊断与证据，或用 `--json-out doctor-report.json` 导出完整报告；摘要仍会明确显示覆盖缺口。

需要重复使用、加载可执行配置或接入插件时，将构建后的包链接到消费项目。请保留本仓库及其依赖：

```bash
pnpm --dir /path/to/your-project link /absolute/path/to/vue-doctor/packages/vue-doctor
pnpm --dir /path/to/your-project exec vue-doctor --scope src
```

## Inspector

```bash
pnpm --dir /path/to/your-project exec vue-doctor --inspect
```

查看诊断、覆盖、规则和抑制审计。筛选读取当前报告，点击**重新运行**才会发起扫描。本地进程持续运行，按 `Ctrl+C` 停止。

[Inspector 用法](./docs/guide/inspector.zh-CN.md)

## 接入 Vite

按上文链接本仓库构建后的 `vue-doctor` 包，再把 `vueDoctor()` 加到现有 Vite plugins 中：

```ts
import { defineConfig } from 'vite'
import { vueDoctor } from 'vue-doctor/vite'

export default defineConfig({
  plugins: [
    // 在这里保留项目已有的 Vue 或 Vue 2 插件。
    vueDoctor()
  ]
})
```

Inspector 地址为 `/vue-doctor/`。webpack、Rspack、Rollup、Rolldown 和 esbuild 的接入见[构建工具文档](./docs/guide/usage.zh-CN.md#构建工具)。

## 配置

可选的 `doctor.config.ts`：

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  scope: 'src',
  rules: {
    'component-prop-type-mismatch': 'error'
  }
})
```

Vue 与组件库检查直接内置；没有项目 ESLint 配置时，内置 ESLint core 规则默认关闭。未知规则 code 会作为配置错误停止运行。

**已有 ESLint 配置：** Doctor 复用项目安装的 ESLint 和 `eslint.config.*`，支持 `@antfu/eslint-config`、`@icebreakers/eslint-config` 以及本地插件。规则选项、文件覆盖和 ignore 均沿用原配置，接入见[详细说明](./docs/guide/configuration.zh-CN.md#项目-eslint)。

**可选的死代码分析：** 显式注册独立的 Knip 规则包，检查未使用的文件、导出值和类型，以及重复导出。参见[接入与覆盖边界](./docs/guide/configuration.zh-CN.md#可选的项目死代码分析)。

### 第三方 UI 组件库

Doctor 从消费项目解析组件库，以组件 import 和全局 plugin 注册作为证据。默认读取已发布的元数据与类型声明，不会扫描每个已安装依赖。可以分析项目已有的 Element Plus（`element-plus`）、Element UI（`element-ui`）等生态组件库；实际契约证据决定覆盖程度。

需要显式选择时，在 `doctor.config.ts` 中配置 `ui`：

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  ui: {
    autoDetect: true,
    libraries: [
      'element-plus',
      { package: '@acme/ui', aliases: ['@ui'] }
    ],
    runtimeContracts: true
  }
})
```

只填写项目已经可以解析的包；`@acme/ui` 是虚构示例，请替换或删除。`aliases` 将 `@ui` 等 import root 映射到对应包的契约，不会替你配置构建工具。设置 `autoDetect: false` 后只分析 `ui.libraries`。可选的 `ui.runtimeContracts: true` 静态分析已发布的 runtime/SFC 源码来补充契约，不执行组件库。缺失导出、动态行为和未解析契约仍然是未知证据，覆盖保持不完整，不能判定为检查通过。分析已有项目无需额外安装 Vue、Vite 或 UI 库。

[UI 契约、别名与证据边界](./docs/guide/configuration.zh-CN.md#项目配置)

### 自定义规则包

从 `vue-doctor/rules` 导入 `defineRule`、`defineRules` 和 `oxcRule`，在可执行的 `doctor.config.ts` 中注册多条真实检查：

```ts
import { defineDoctorConfig } from 'vue-doctor'
import { defineRule, defineRules, oxcRule } from 'vue-doctor/rules'

const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: { title: '避免 var', description: '使用 let 或 const。' },
      check: oxcRule({
        create: context => ({
          VariableDeclaration(node) {
            if (node.kind === 'var') context.report({ node, message: '请使用 let 或 const。' })
          }
        })
      })
    }),
    'no-debugger': defineRule({
      meta: { title: '移除 debugger', description: '不要提交 debugger 语句。' },
      check: oxcRule({
        create: context => ({
          DebuggerStatement(node) {
            context.report({ node, message: '请移除此 debugger 语句。' })
          }
        })
      })
    })
  }
})

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: { 'team/no-var': 'warning', 'team/no-debugger': 'error' }
})
```

执行 `pnpm exec vue-doctor --config ./doctor.config.ts --scope src`。规则包名构成命名空间，严重度配置使用完整 code。私有策略模块或包应保存在公开仓库之外，或放入未被跟踪且已在本地忽略的文件；不要随共享配置发布。规则包属于受信任的可执行代码，不能放进 JSON，Doctor 也不会自动下载它们。

[完整指南：导出可复用规则包、导入配置并触发两条检查](./docs/guide/custom-rules.zh-CN.md)

## CI

```bash
pnpm exec vue-doctor --fail-on error --fail-on-incomplete-coverage
```

本地扫描默认不因诊断而失败，配置与运行错误仍会失败。只有诊断为空**且覆盖完整**，才能判定项目干净。

[CI 配置、变更文件扫描与局部抑制](./docs/guide/configuration.zh-CN.md)

## Agent 接入

没有 dev server 时，启动独立 MCP 服务：

```bash
node /absolute/path/to/vue-doctor/packages/vue-doctor/dist/cli.mjs mcp /path/to/project
```

Inspector 已运行时可通过 Devframe 连接。客户端配置与 Skill 安装见 [MCP 与 Agent 文档](./docs/guide/mcp.zh-CN.md)。

## 文档

| 主题 | 文档 |
| --- | --- |
| CLI 与构建工具 | [使用方式](./docs/guide/usage.zh-CN.md) |
| 配置、CI 与抑制 | [配置](./docs/guide/configuration.zh-CN.md) |
| 内置规则与 Vue 版本 | [规则](./docs/guide/rules.zh-CN.md) |
| 自定义 AST 规则 | [规则编写](./docs/guide/custom-rules.zh-CN.md) |
| 报告、JavaScript API 与覆盖 | [报告](./docs/guide/reports.zh-CN.md) |
| 缓存与性能 | [性能](./docs/guide/performance.zh-CN.md) |

[完整文档索引](./docs/guide/README.zh-CN.md)
