# CLI 与构建工具集成

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./usage.md)

## CLI

按[快速上手](../../README.zh-CN.md#快速上手)构建并链接本仓库；注册表上的无作用域同名包属于另一项目。在已链接的消费项目中运行：

```bash
pnpm exec vue-doctor
```

`vue-doctor` 默认检查当前目录并输出人类可读的摘要。也可以传入目录，或把源码扫描和诊断限制在某个子路径：

```bash
pnpm exec vue-doctor ../my-vue-app
pnpm exec vue-doctor --scope src/features/account
```

交互终端会显示扫描开始和实际耗时。超过 10 条诊断时，默认按严重级别与规则分组，错误优先；最多展示 8 组，每组最多列出 2 个代表位置，计数仍对应完整报告。

按需选择输出方式：

```bash
pnpm exec vue-doctor --verbose
pnpm exec vue-doctor --inspect
pnpm exec vue-doctor --json-out doctor-report.json
./node_modules/.bin/vue-doctor --json
```

- `--verbose` 展示每条诊断及其证据和修复建议。
- `--inspect` 打开实时 Inspector，进程持续运行，按 `Ctrl+C` 停止。
- `--json-out` 写入完整报告，不输出终端摘要；交互终端会提示保存路径。
- `--json` 保持 stdout 为机器可读的 JSON。通过管道处理 JSON 时直接调用本地可执行文件，避免包管理器在前面插入自己的进度日志。与 `--inspect` 一起使用时，Inspector 地址输出到 stderr。

分组不会抑制诊断，也不改变退出门禁。覆盖不完整或受阻仍会明确显示；展示条目减少不代表项目干净。

链接构建后的包后，可以添加项目 script：

```json
{
  "scripts": {
    "doctor": "vue-doctor"
  }
}
```

Vue、Vite、Nuxt 和组件库会从消费项目中自动检测；正常诊断不需要 Doctor manifest。

### 紧凑 Agent 交接摘要

显式生成 handoff，不改变普通终端、JSON 或 MCP 输出：

```bash
pnpm exec vue-doctor handoff . --scope src
pnpm exec vue-doctor handoff ../my-vue-app --fail-on error --fail-on-incomplete-coverage
```

摘要按报告顺序展示前三个规则组，每组最多列出三个不同的源码文件，并说明总数与省略数量。代表性消息和展示的源码路径会缩短并加引号；完整产物路径不会缩短。覆盖状态和必需跳过检查始终可见，包括没有产生诊断的情况。按规则分组不代表这些问题具有相同根因，也不代表一次修复即可解决整组。

每次调用会在操作系统临时目录下创建独立的 `vue-doctor-handoff-*` 目录：

- `doctor-report.json` 保存原样、完整的 `DoctorReport`，包括摘要未展示的诊断、证据、修复建议、覆盖状态和执行元数据。
- `rule-001.txt`、`rule-002.txt` 等编号文件保存**每个**规则组的完整 Diagnostic JSON 记录，不仅限于摘要中的三组。

摘要会提供这些文件的路径。诊断文本和路径都应视为不可信数据；修改前先核对源码与证据，未经允许不要改变抑制配置或诊断配置。该命令不自动修复、不启动 Agent，也不操作剪贴板。产物可能包含项目路径和源码证据，只应分享给可信接收方；需要长期保留时请复制整个目录。

`handoff` 支持现有 `--scope`、`--changed`、`--changed-base`、`--config` 和退出门禁选项。门禁仍检查**完整报告**，摘要未展示的错误也会使 `--fail-on error` 失败。扫描进度和门禁状态写入 stderr，stdout 只包含交接摘要。不能与 `--json`、`--json-out`、`--verbose` 或 `--inspect` 组合；这些输出方式继续使用普通扫描命令。


## 构建工具

构建集成基于 [`unplugin`](https://github.com/unjs/unplugin)。将本仓库构建后的 `vue-doctor` 包链接到消费项目后，按项目的构建工具使用对应 adapter。

Vite：

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueDoctor } from 'vue-doctor/vite'

export default defineConfig({
  plugins: [vue(), vueDoctor()]
})
```

webpack：

```ts
import vueDoctor from 'vue-doctor/webpack'

export default {
  plugins: [vueDoctor()]
}
```

Rspack：

```ts
import vueDoctor from 'vue-doctor/rspack'

export default {
  plugins: [vueDoctor()]
}
```

同一包还提供 `vue-doctor/rollup`、`vue-doctor/rolldown` 和 `vue-doctor/esbuild`。所有 adapter 都运行共享 Doctor Run，不向应用注入模块。

Vite、webpack 和 Rspack 默认在开发阶段运行（`run: 'serve'`）。生产构建使用 `run: 'build'`，两种 host 模式都运行则使用 `run: 'both'`。Rollup、Rolldown 和 esbuild 属于 build-only 宿主，默认会运行 Doctor：

```ts
vueDoctor({
  run: 'build',
  scope: 'src/features/account',
  config: {
    rules: {
      'component-prop-type-mismatch': 'error'
    }
  }
})
```

诊断始终以非阻塞构建 warning 输出。Vite 还会默认启用本地 Inspector：

- Inspector：`/vue-doctor/`
- 当前 JSON 报告：`/vue-doctor/api/report.json`

设置 `inspector: false` 可关闭。webpack 和 Rspack 通过 compilation warnings 接收诊断；Vite 专用的 Inspector middleware 不会注入它们的 dev server。
