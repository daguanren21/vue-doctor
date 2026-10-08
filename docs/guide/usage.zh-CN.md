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
