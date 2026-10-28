# Vue Doctor

[English](./README.md)

根据项目实际安装的 Vue 版本和组件库契约，诊断 Vue 2.7 与 Vue 3 项目。通过 CLI、Inspector 或 MCP 客户端查看诊断、源码证据和覆盖情况。

推荐 **Node.js 26**（支持范围：`^22.18.0 || >=24.11.0`）。即使用 Bun 安装依赖，也请用 Node.js 执行；目前不支持显式使用 Bun 运行时。Vue、Vite、Nuxt 和 UI 库从项目中识别，Doctor 不会替你安装业务依赖。

## 安装与扫描

内置规则和内部模块均包含在 **`@daguanren21/vue-doctor`** 中，无须单独安装规则包或内部 npm 包。

```bash
npm install -g @daguanren21/vue-doctor
vue-doctor /absolute/path/to/project
vue-doctor /absolute/path/to/project --scope src
vue-doctor /absolute/path/to/project --inspect
```

在项目内直接执行 `vue-doctor` 会扫描当前目录。`--scope` 将诊断限制在项目内的相对文件或目录，不会改变项目根目录。用 `--verbose` 查看完整诊断详情，或用 `--json-out doctor-report.json` 导出完整报告。

使用 TypeScript 配置、自定义规则 import 或构建工具集成时，还需要让消费项目能够解析**同一个公开包**：

```bash
npm install --save-dev @daguanren21/vue-doctor
```

仅全局安装 CLI，不会让项目配置文件中的包 import 自动可解析。

## Inspector 与 Vite

`vue-doctor /absolute/path/to/project --inspect` 打开本地 Inspector，并持续运行到按下 `Ctrl+C`。可查看诊断、源码证据、覆盖、规则和抑制审计。筛选读取当前快照，点击**重新运行**才会发起新扫描。

在已有 Vite 项目的 `vite.config.ts` 中，将 `vueDoctor()` 加入现有 plugins：

```ts
import { defineConfig } from 'vite'
import { vueDoctor } from '@daguanren21/vue-doctor/vite'

export default defineConfig({
  plugins: [
    // 在这里保留项目已有的 Vue 或 Vue 2 插件。
    vueDoctor()
  ]
})
```

启动项目原有的 Vite dev server，访问 `/vue-doctor/`。只有该集成需要 Vite，独立 CLI 扫描不需要。详见 [Inspector 指南](./docs/guide/inspector.zh-CN.md)和[其他构建工具](./docs/guide/usage.zh-CN.md#构建工具)。

## 封装并启用自定义规则

`defineRule` 封装可复用检查，`oxcRule` 提供脚本 AST visitor。在消费项目中创建独立模块 **`doctor-rules.ts`**：

```ts
import { defineRule, oxcRule } from '@daguanren21/vue-doctor/rules'

export const noDebugger = defineRule({
  meta: {
    title: 'Remove debugger statements',
    description: 'Do not commit debugger statements.'
  },
  check: oxcRule({
    create: context => ({
      DebuggerStatement(node) {
        context.report({ node, message: 'Remove this debugger statement.' })
      }
    })
  })
})
```

在旁边的 **`doctor.config.ts`** 中，用 `defineRules` 注册规则包并启用规则：

```ts
import { defineDoctorConfig } from '@daguanren21/vue-doctor'
import { defineRules } from '@daguanren21/vue-doctor/rules'
import { noDebugger } from './doctor-rules.ts'

const teamRules = defineRules({
  name: 'team',
  rules: { 'no-debugger': noDebugger }
})

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: { 'team/no-debugger': 'error' }
})
```

规则包名构成命名空间：严重度必须使用**完整 code** `team/no-debugger`（可选 `error`、`warning`、`info` 或 `off`）。仅 import 规则不会注册它，还需配置 `rulePacks`。未知规则 code 会作为配置错误停止运行。

可在临时测试项目中创建 **`src/rule-demo.ts`**：

```ts
debugger
export {}
```

在该项目中执行：

```bash
vue-doctor --config ./doctor.config.ts --scope src/rule-demo.ts --json
```

预期得到带源码位置的 `team/no-debugger` error。删除 `debugger` 可消除这条诊断，但其他已启用规则和覆盖缺口可能仍然存在。这是教学规则；已有 ESLint 规则能满足需求时，优先复用。

配置和导入的规则包属于**受信任的可执行代码**。Doctor 不会下载规则包，JSON 配置也不能导入规则函数。私有策略应放在外部或私有模块中，或保存在未被跟踪且已本地忽略的文件中，切勿随共享配置发布。可复用规则包、解析后端和证据要求见[规则编写指南](./docs/guide/custom-rules.zh-CN.md)。

## MCP 客户端

完成上述全局安装后，将以下 stdio 服务加入 MCP 客户端配置，并替换项目绝对路径：

```json
{
  "mcpServers": {
    "vue-doctor": {
      "command": "vue-doctor",
      "args": ["mcp", "/absolute/path/to/project"]
    }
  }
}
```

客户端必须能从 `PATH` 找到 `vue-doctor`；否则将 `command` 改为可执行文件的绝对路径。不需要 dev server 或浏览器。服务持有分析会话，直到客户端断开；stdout 仅用于 MCP 消息。可在 `args` 中追加 `"--scope", "src"` 来限制诊断范围。

先调用 `vue-doctor_help` 和 `vue-doctor_get-overview`，再使用返回的 `snapshotId` 查询诊断、源码和覆盖。这些工具不会编辑源码或应用修复。授权修改后，用 `vue-doctor_rescan` 显式重新分析；筛选结果为空不代表项目干净。详见 [MCP、Inspector 连接与 Agent Skill](./docs/guide/mcp.zh-CN.md)。

## 覆盖与 CI

Vue 与组件库检查直接内置。Doctor 从消费项目的 import、plugin 注册、已发布元数据和类型中解析 UI 契约。缺失契约与动态行为仍是未知，不能判定为已验证。已有项目 ESLint 配置也可以提供规则；没有该配置时，内置 ESLint core 委托规则可用但默认关闭。

本地扫描默认不因诊断而失败，配置和运行错误仍会失败。CI 可使用：

```bash
vue-doctor /absolute/path/to/project --fail-on error --fail-on-incomplete-coverage
```

只有诊断为空**且覆盖完整**，才能判定项目干净。详见[配置、ESLint、UI 契约与抑制](./docs/guide/configuration.zh-CN.md)。

## 更多文档

[CLI 与构建工具](./docs/guide/usage.zh-CN.md) · [内置规则](./docs/guide/rules.zh-CN.md) · [报告与 JavaScript API](./docs/guide/reports.zh-CN.md) · [性能](./docs/guide/performance.zh-CN.md) · [完整索引](./docs/guide/README.zh-CN.md)
