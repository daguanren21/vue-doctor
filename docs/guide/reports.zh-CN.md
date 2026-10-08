# 报告与覆盖率

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./reports.md)

## JavaScript API

公开 facade 返回的报告与 CLI、Vite 集成使用的是同一个模型：

```ts
import { runDoctor } from 'vue-doctor'

const report = await runDoctor()
```

`runDoctor()` 默认使用当前目录。集成需要明确项目位置或源码子路径时，可以传入 `{ root }` 或 `{ scope }`。可选的 `{ files }` 精确文件列表进一步限制有效 scope 内的源码文件，支持相对 root 的路径或绝对路径；`files: []` 会生成零目标的新报告。非法 scope 或目标路径仍会记录覆盖问题，空目标列表也会验证 scope。

诊断目标与 `projectContext` 分开。局部扫描仍会读取相关应用入口和目标集之外的注册信息。库存从每个消费包所在位置解析实际安装包，支持父工作区安装和 npm alias。Vue 版本和插件注册分别关联所属包、所属应用；影响组件分析的未知应用归属写入 `coverage.source.contextIssues`。

## JSON 报告

命令行自动化可以把 JSON 输出到 stdout，或写入文件：

```bash
vue-doctor --json
vue-doctor --json-out .vue-doctor/report.json
```

两种方式都使用共享的 `DoctorReport` 模型：

```json
{
  "schemaVersion": 1,
  "run": {
    "status": "complete",
    "target": { "mode": "project", "scopes": [], "files": [] }
  },
  "project": {
    "root": "/path/to/project",
    "vueFramework": "vue3",
    "uiLibraries": ["element-plus"]
  },
  "inventory": { "root": "/path/to/project", "packages": {} },
  "coverage": {
    "status": "complete",
    "source": { "status": "complete", "scannedFileCount": 0, "failedFiles": [] },
    "componentLibraries": []
  },
  "diagnostics": [],
  "checks": [],
  "suppressionAudit": []
}
```

新报告使用 schema version 1。没有版本字段的报告按 legacy v0 读取；Inspector 会拒绝不支持的未来版本。`diagnostics[].id` 是 `vd1:` 开头的诊断事实指纹，不随 checkout 目录、Git 归属、严重度策略和数组顺序变化；源码或证据变化可以改变 ID。`primaryLocation` 明确声明 `file`、`line`、`point` 或 `range` 精度：已有行列号统一从 1 开始，范围结束位置不包含在内；缺失列号保持未知。`fixes` 是修复建议（`kind: 'suggestion'`），可选的 `edits` 单独保存明确的文本编辑。Inspector 只预览这些字段。

## 诊断与覆盖率

可选的 `ruleCatalogs` 保存本次运行发现的规则元数据，包括零诊断的项目 ESLint 规则，不包含可执行插件或规则函数。`rulePacks` 继续只记录显式启用的外部规则包及其执行情况。

报告新增 `diagnostics[].domain`、`tags`、`rulePack` 和 `domainCoverage`。问题领域包括组件库契约、CSS/样式、交互行为、Vue 语法/API、Vite 和规范建议；未声明领域的规则归入“未分类”。每条诊断只有一个主要领域，跨领域标签不会重复增加计数。Inspector 按领域分组，可搜索标签，也可从规则页点击标签查看相关诊断。

领域覆盖分别记录 `not-covered`、`not-reported`、`partial` 和 `complete`；规则数量表示已注册的规则定义。尚未接入 Vite 规则包时，Vite 明确显示“未覆盖”，检测到安装版本不等于完成 Vite 检查。顶层 `checks` 统一记录内置与外部规则的执行状态，包括禁用、不适用、证据不足和部分执行。未知 Vue 版本和源码块解析失败有明确原因；人工、运行时及规范待定项仍属待验收。`rulePacks` 继续只描述显式启用的外部规则包。配置中的未知规则 code 会作为配置错误停止运行，包括配置为 `off` 的未知 code。

Vue API 检查追踪来自 `vue` 的真实导入，支持 named alias 和 namespace，并排除局部同名遮蔽。编译宏只在未遮蔽的 `<script setup>` 中识别。自动导入的裸名称需要集成方提供明确证据，名称本身不能证明它是 Vue API。

缺失事件、slot 或 model 更新事件，只在相关 acceptance 边界被证明 closed 时报告 unsupported；open 边界接受使用，unknown 或冲突边界记录必需检查跳过。事件处理器可以少接参数、改名或忽略参数。payload 诊断要求完整签名，只有所有重载提供的参数数量都少于处理器必需参数时才触发；optional 与 rest 信息会保留。

`diagnostics` 包含针对已检测组件用法的确定性发现，例如不支持的 prop、event、slot 或 `v-model`，以及不兼容的事件 payload。每条 diagnostic 都包含 code、severity、confidence、evidence 和 suggested fixes。

只有在组件 prop 边界与 Vue attribute 透传边界都被证明确实 closed 时，缺失的 prop 才会报告为 unsupported。`$attrs` 只表示一条转发边，Vue Doctor 会继续检查接收它的内部组件是否声明或安全转发了当前 attribute；原生根元素也必须由已安装的 DOM 类型证据确认支持该 attribute。无法解析完整转发链时默认只保留 partial coverage，避免报告被 info 淹没；需要逐用法信息时可配置 `rules['component-attribute-unverified'] = 'info'`。

`coverage` 描述 Vue Doctor 能够确认多少信息。整体状态为 `complete`、`partial` 或 `blocked`，并分别记录源码扫描覆盖情况和每个组件库的 contract coverage。缺失或不完整的 contract knowledge 写入受影响组件库的 `coverage.componentLibraries[].problems`；`diagnostics` 只保留有证据支持的代码问题。

这种区分让自动化系统能够分辨“发现了问题”和“检查无法完整确认”。

## 契约证据来源

Vue Doctor 会优先使用已安装包发布的组件元数据，包括 `web-types` 和 Vetur metadata。TypeScript declaration files 会补充这些证据；当元数据为空，或某个 contract dimension 仍然未知时，类型声明可以提供组件 contract。

每个组件库的 `coverage.componentLibraries[].contractSources` 会记录 contract knowledge 的来源，例如 adapter、`web-types`、Vetur metadata 或 TypeScript declarations，并附带相关 evidence location。因此，使用者既能看到结论，也能看到它的 provenance。

## 什么时候算 clean

只有同时满足以下两个条件，一次运行才是 clean：

1. `diagnostics` 为空。
2. `coverage.status` 为 `complete`。

零 diagnostics 但 coverage 为 `partial` 或 `blocked`，只表示 Vue Doctor 在能够分析的证据范围内没有发现问题。CI 和 agent 应把这种状态报告为检查不完整，而不是 clean。
