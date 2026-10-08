# 配置与 CI

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./configuration.md)

## 项目配置

可选项目配置（按发现顺序生效）：

1. `doctor.config.ts`、`.mts`、`.js`、`.mjs`、`.cjs`、`.json`，按此顺序查找。
2. `vue-doctor.config.*`，后缀顺序与上面一致。
3. `package.json#vueDoctor`；该字段不存在时读取 `package.json#vue-doctor`。

CLI 显式指定 `--config` 时直接使用该路径，不进行自动发现。

可执行配置模块及其本地 import 以同步模式加载，确保每次实际运行都能读到本地依赖修改。不支持模块顶层 `await`；异步分析放在规则包的 `run()` 中。

```json
{
  "scope": "src",
  "rules": {
    "vue-prefer-use-template-ref": "info",
    "component-prop-type-mismatch": "error"
  },
  "failOn": "error",
  "failOnIncompleteCoverage": true
}
```

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  ui: {
    autoDetect: true,
    libraries: [
      'element-plus',
      { package: '@acme/ui', aliases: ['@ui'] }
    ]
  },
  rules: {
    'vue-prefer-define-model': 'info'
  },
  failOn: 'error'
})
```

`ui.libraries` 用于显式接入已安装的 UI/组件库；`aliases` 把项目中的 `@ui` 等 import root 映射回拥有 contract 的包。`autoDetect: true` 会分析源码中通过组件 import 或全局 plugin 注册观察到的包，不会遍历解析 `node_modules` 的每个 dependency。只分析显式配置的组件库时设置 `autoDetect: false`。配置的包从消费项目 `node_modules` 解析，即使它不是顶层 dependency 也能接入。Doctor Run 默认读取 metadata 与 declaration，也会识别 metadata description 明确提到的 slot name。需要用包内发布的 runtime/SFC source 补充不完整的 slot、prop 和 fallthrough contract 时，设置 `ui.runtimeContracts: true`。

仅凭 runtime 创建组件 contract 时，必须验证公开导出，不能只靠文件名或组件名相同。Doctor 会追踪静态包内 ESM/CommonJS 导出，以及受支持的 webpack 入口与 source map 到已发布源码的关联。缺失、过期、越界或不支持的 source map 证据不能证明组件公开可用。支持 Vue 2 的 `<template functional>`，但不会据此推断有状态组件的 attribute/listener 透传或默认 model。

开启 runtime contract 后，包内发布的 SFC 还可提供 Options API `$emit` 调用、已验证的 `setup(props, { emit })` 或 `setup(props, context)` 发射函数、模板监听器和显式 `emits` 声明中的静态事件名。setup 发射函数的别名和嵌套回调只有在词法身份保持一致时才会被追踪；被遮蔽、重赋值、传给未知函数或被覆盖的绑定不构成正向证据。这些只构成正向证据：未找到的事件名、动态发射和不完整的 payload 签名仍保持未知。Doctor 静态解析源码，不执行 prop 默认值或 mixin 工厂，也不会把观察到的事件当成完整的事件列表。

包内发布的 JS、JSX、TS、TSX 模块中，带静态组件名的默认导出也可提供同类交互证据，包括由已验证的 Vue `defineComponent` import 包装的选项。静态包内 `extends` 和 mixin 会保留 model/事件来源，并遵循方法覆盖关系。被修改或传给未知函数的选项绑定、未知继承和动态监听器转发目标不构成支持证明；已被子组件覆盖的继承方法不能再证明该事件存在。

嵌套 class 实例，以及被覆盖的 watcher、访问器回调，不构成组件事件证据。slot、循环、script-setup 和事件处理函数内名为 `$emit` 的局部绑定，不会被误当作组件发射函数。`<script setup>` 会替换普通脚本的 `setup` 回调以及其生成的 `emits` 声明，继承的 SFC 也遵循这一覆盖关系。通过选项别名、容器或回调发生的修改或外传会使继承证据失效；稳定别名仍受支持。Vue 2 与 Vue 3 对继承的 `setup` 执行方式不同，因此不把这类回调当作跨版本事件证明。

事件检查区分“事件是否支持”与“处理函数是否使用 payload”。Vue 2 `.native` 监听根 DOM 元素，不要求组件事件 contract；Vue 3 或版本未知时不作这一豁免。事件支持已证明且处理函数确定不使用 payload 时，不要求 payload 签名。读取 payload、默认值/解构、动态调用、处理函数被覆盖或外传时仍保持未知。metadata 只列出事件名不等于“零参数”：Web Types 必须显式提供空参数列表才能证明零参数签名，Vetur 事件名的 payload 则保持未知。

`v-model` 按消费包的 Vue 版本检查。Vue 2 需要静态确定的 `model` 配置或已验证的默认 `value`/`input` 映射；包内静态 `extends`、mixin 会在循环检测和包边界约束下追踪。Vue 3 使用 `modelValue`/`update:modelValue` 或显式 model 参数。版本未知、动态 model 配置或无法读取的继承配置仍产生必需的跳过记录。同一映射也用于判断 `v-model` 是否提供了必填 prop。直接调用 `diagnoseComponentLibraryUsageResult` 时应传入 `vueVersion`；混合版本工作区可提供按文件区分的 `vueVersions`，文件版本显式未知时不会回退到根版本。

未解析的 `v-bind` spread 只有在必填 prop 可能仍未提供时才阻塞必填检查；显式 prop 和按版本正确映射的 `v-model` 都计入已提供项。直接调用 `analyzeComponentLibraries` 时也应传入按文件区分的 `vueVersions`，让 coverage 与诊断使用相同的事件适用性判断。不适用的检查被移除，不代表未知 contract 维度变成已知。

### 项目别名与应用归属

应用发现读取消费包 `tsconfig.json` 中显式的 `compilerOptions.paths`；不存在 tsconfig 时才读取 `jsconfig.json`。支持本地 JSONC `extends`、映射声明位置和按顺序尝试的目标。仅指向 declaration 的映射和会被擦除的 type import 不进入运行时应用图。Doctor 不猜测 `@ = src`，也不为读取 alias 执行 Vite/Webpack 配置；无法解析、非本地或有歧义的配置仍保留上下文不足。alias 和 symlink 均不能越过消费包边界。

别名匹配遵循 TypeScript 优先级：先精确匹配，再选最长匹配前缀；前缀等长时保留声明顺序。

Vue 2 构造器注册通过同步运行时 import 关联到使用相同构造器的根实例，包括入口和 router 模块。只有注册而没有根实例的模块不再被当作额外应用；懒加载或条件安装不构成全局可用的证明。Vue 3 注册仍归属于各自应用。

扫描到的组件若不在已发现的应用图中，不能借用该应用的全局注册。应显式 import 并局部注册依赖，或建立真实且可静态发现的应用 import 路径。Doctor 不会通过排除这些文件或虚构应用归属让 coverage 变成完整。

字面量 `import.meta.glob` 调用会把候选模块加入应用可达图，但不扩大诊断目标。支持相对路径、项目根路径、只有一个显式映射目标的别名，以及静态 pattern 数组和排除项。懒加载候选不证明插件已经安装；只有 `{ eager: true }` 才产生同步模块边。动态 pattern/options、`?raw` 等资源 query、不支持的选项和有歧义的别名仍保持未解析。展开时排除依赖目录、嵌套包和越界 symlink 路径。

Vite 只读取文件名的 `Object.keys(import.meta.glob(...))` 形式不产生模块边，即使设置了 `eager: true`。展开时会保留目录名中 glob 元字符的字面含义，并关闭 extglob 操作符，与 Vite 的模块转换保持一致。动态目录之后含有需要归一化的 `.` 或重复分隔符时，pattern 保持未解析，因为 Vite 开发与生产转换可能加载不同的模块。

## 项目 ESLint

Doctor 默认在发现 `eslint.config.*` 时使用消费项目安装的 ESLint。`@antfu/eslint-config`、`@icebreakers/eslint-config` 等 preset、自定义插件、parser、processor、规则 options 和文件覆盖均交给该 ESLint 加载，无须单独编写 Doctor 适配器。

在 Doctor 配置的 `eslint` 中选择模式或指定 ESLint 配置：

```ts
import { defineDoctorConfig } from 'vue-doctor'

export default defineDoctorConfig({
  eslint: {
    mode: 'project',
    configFile: './eslint.config.mjs'
  }
})
```

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 有项目配置则复用；没有配置则保留内置 ESLint 规则按需开启的行为。 |
| `project` | 必须有项目 ESLint 和配置。 |
| `builtin` | 使用 Doctor 独立执行的可选 ESLint core 规则。 |
| `off` | 关闭通用 ESLint 接入。 |

项目模式要求消费包能够解析 ESLint 9 或更新版本。`eslint.configFile` 支持项目根目录相对路径或绝对路径，仅用于 `auto`、`project` 模式。它与选择 Doctor 配置的 CLI `--config` 不同。TypeScript ESLint 配置遵循消费项目 ESLint 的加载要求，所需 loader 应由该项目提供。

运行时还须满足项目 ESLint、parser 和 plugin 的 Node.js 要求，这些要求可能高于 Doctor 的最低版本。项目依赖不兼容时会作为配置加载错误停止运行。

使用 `--scope src` 等限定范围时，即使配置只在该范围内，ESLint 9 也能按配置所在目录启动原生查找；ESLint 10 保留逐文件查找。显式 `eslint.configFile` 仍按项目根目录处理文件匹配。

项目规则 ID 保留原别名：`vue/no-mutating-props` 对应 `eslint/vue/no-mutating-props`，`ts/no-explicit-any` 对应 `eslint/ts/no-explicit-any`。每个文件的诊断保留 ESLint 输出的严重度和定位。Doctor `rules` 可以覆盖报告严重度或关闭已注册检查，不修改项目规则 options，也不扩大项目适用文件范围。

ESLint ignore 仅影响 ESLint 检查，Vue 与组件契约分析仍使用 Doctor 的目标范围。缺少 ESLint、无效配置或插件加载失败直接停止运行，不回退内置规则。单文件解析或类型分析失败保留覆盖不足。

配置选中的目标包含 `bin/tool` 这类无扩展名文件。processor 规则发现和正式执行使用同一份源码快照，即使快照文本切换了虚拟文件的语言。虚拟规则没有产生诊断时也保留文档信息。快照读取失败不会重新读盘：报告保留读取错误和必需的跳过记录，不会误报覆盖完整。

可读源码仍交给项目 ESLint 分析，即使 Vue Doctor 的 Vue 解析器无法生成任何块（例如空 SFC）。ESLint 是否接受语法由项目自己的解析器决定。内联指令引用不可用规则时，ESLint 返回的诊断也会保留，不会中断整次扫描。

Vue 模板正文允许比较符号、字符列表等场景中的字面量 `<`；Vue descriptor 与模板 AST 均保留该文本时，Doctor 不再把它误判为解析失败。错误闭合标签、重复顶层块和空 SFC 仍保留源码覆盖不足，但不会阻止可读字节交给项目 ESLint。

## 可选的项目死代码分析

`@vue-doctor/rule-pack-dead-code` 通过 Knip 提供按需开启的项目死代码分析。它是独立的可选包，**不会随默认 runner 自动捆绑或启用**。当前 workspace 版本为 `0.0.0`，尚未发布。按[快速上手](../../README.zh-CN.md#快速上手)构建本仓库并链接 `vue-doctor` 后，还需将构建好的规则包链接到消费项目：

```bash
pnpm --dir /path/to/your-project link /absolute/path/to/vue-doctor/packages/rule-pack-dead-code
```

在可执行的 `doctor.config.ts` 中注册：

```ts
import { defineDoctorConfig } from 'vue-doctor'
import { createDeadCodeRulePack } from '@vue-doctor/rule-pack-dead-code'

export default defineDoctorConfig({
  rulePacks: [createDeadCodeRulePack({ timeoutMs: 120000 })],
  rules: {
    'dead-code/unused-export': 'error',
    'dead-code/unused-type': 'off'
  },
  failOn: 'error',
  failOnIncompleteCoverage: true
})
```

注册规则包后，以下四项检查的默认严重度均为 `warning`：

| Code | 报告内容 |
| --- | --- |
| `dead-code/unused-file` | 从配置的入口点不可达的文件。 |
| `dead-code/unused-export` | 在项目图中没有消费者的导出值。 |
| `dead-code/unused-type` | 在项目图中没有消费者的导出类型、接口和枚举。 |
| `dead-code/duplicate-export` | 同一模块中被多次导出的符号。 |

通过 Doctor 的 `rules` 修改严重度，或将任意 code 设为 `'off'`。四项全部关闭或目标文件集合为空时，不执行 Knip 分析。

`createDeadCodeRulePack()` 默认使用 Knip 的配置发现机制，超时为 `120000` 毫秒（两分钟）。可选的 `configFile` 用于选择已有的 Knip 配置，例如 `createDeadCodeRulePack({ configFile: './knip.json' })`；支持相对 Doctor 项目根目录的路径或绝对路径。`timeoutMs` 用于调整超时。Knip 配置与选择 Doctor 配置的 CLI `--config` 相互独立。

项目图由 Knip 原生的 `entry`、`project`、`ignore` 和插件配置决定。Doctor 控制这四类受支持检查是否运行及报告严重度，覆盖 Knip 针对这些检查的 `include`、`exclude` 和 `rules` 设置。图的输入在 Knip 中配置，检查开关与严重度在 Doctor 中配置。

即使使用 `--scope`、`--changed` 或显式选择文件，分析仍会从磁盘读取**配置所定义的完整项目图**。只有诊断结果按 Doctor 的目标文件过滤；目标范围外的消费者仍参与分析。缩小目标范围不保证图分析更快。

Knip 报告的 import 缺失或无法解析、配置或插件错误，以及覆盖不足相关提示，都会使所有启用的死代码检查变为 `unavailable`；分析超时也会如此。报告保留必需的 `skippedChecks` 和覆盖不足，而不是判定项目干净。示例中的 `failOnIncompleteCoverage: true` 会让此类覆盖缺口导致运行失败，即使没有产生任何诊断。

使用 Knip 原生 `workspaces` 配置时，应把 `entry`、`project` 模式放在相应工作区条目中。被忽略的顶层模式（`entry-top-level` / `project-top-level`）属于覆盖缺口，不代表这些路径已成功检查。

这些图覆盖检查依赖 Knip 报告的缺口；完整项目图分析不等于全项目语法验证。Doctor 现有的源码解析覆盖仍仅限于选中的源码目标。

只加载受信任的可执行 Knip 配置和插件。分析在子进程中运行，以隔离其输出与 Doctor 报告。超时会终止直接的 Knip 工作进程并释放 Doctor 的报告通道，但不会管理项目配置自行启动的任意辅助进程。这种隔离**不是安全沙箱**。

这些诊断来自静态项目图：动态入口或 Knip 无法发现的消费者可能导致误报。删除或合并代码前，请先确认图配置与实际使用情况。本规则包不执行自动修复。

## CI 与 CLI 覆盖

```bash
vue-doctor --version
vue-doctor --fail-on error
vue-doctor --fail-on warning --fail-on-incomplete-coverage
vue-doctor --config ./doctor.config.json
vue-doctor rules list
vue-doctor rules explain component-prop-required-missing
```

本地扫描默认不因诊断或覆盖不足而失败，配置与运行错误仍会导致命令失败。使用 `--fail-on` 或配置 `failOn` 启用诊断门禁，使用 `--fail-on-incomplete-coverage` 或 `failOnIncompleteCoverage: true` 要求覆盖完整。

`--version`（或 `-v`）输出当前安装的 Vue Doctor 版本后直接退出，不加载项目配置或扫描文件。

安装 GitHub Actions 工作流脚手架：

```bash
pnpm exec vue-doctor ci install
pnpm exec vue-doctor ci install --fail-on warning --force
```

生成的工作流默认对 error 诊断和覆盖不足启用门禁。

工作流只运行项目已安装的 Vue Doctor 可执行文件（Yarn 项目使用本地命令解析），不会按注册表包名下载 CLI。启用 CI 前，应通过可复现的 workspace 或构建产物依赖提供本仓库的工具；快速上手中的开发机本地链接不能直接用于托管 runner。

## 变更文件扫描

仅扫描 git 变更文件（适合 PR）：

```bash
vue-doctor --changed
vue-doctor --changed --changed-base origin/main
vue-doctor --changed --fail-on error --json
```

扫描目标取 changed 文件与有效 scope 的交集：显式 `--scope` 优先，否则使用项目配置的 scope。每次运行只加载一次可执行配置。Git 路径先按仓库根解析，再限制到当前消费项目，支持 monorepo 子项目。零变更仍会为 `--json`、`--json-out` 和 Inspector 生成新报告。不存在或不可读的扫描路径写入 `coverage.source.discoveryIssues`，使源码覆盖保持 partial；合法空目标集为 complete。生成的 CI workflow 在 PR 使用显式 base 计算 merge-base，在 push 执行全量扫描。

## 局部抑制与审计

按具体规则抑制指令所在行或下一行，必须填写原因：

```ts
// vue-doctor-disable-next-line vue-shallow-ref-nested-mutation -- 已确认此处更新流程
state.value.count++
state.value.count++ // vue-doctor-disable-line vue-shallow-ref-nested-mutation -- 已确认此处更新流程
```

指令必须位于真实的脚本、template/HTML 或 CSS 注释中；字符串中的文本不生效。多行注释的 `disable-next-line` 指向注释结束后的下一行。不支持全文件抑制或通配规则。无效、未知和未命中的指令保留在 `suppressionAudit`，已应用的条目保留原诊断、ID、定位和原因。抑制只移除有效诊断及其严重度门禁，不改变规则执行记录、必需跳过项、运行状态和覆盖不足门禁。Inspector 的审计视图可查看审计。
