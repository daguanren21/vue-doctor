# 编写自定义 AST 规则

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./custom-rules.md)

## 定义并导出规则包

下面两个文件组成可运行的本地规则包。项目可以解析 `vue-doctor` 后，将规则模块保存为 `doctor-rules.ts`。从公开入口 `vue-doctor/rules` 导入编写 API；这个 Oxc 示例不需要内部包路径或额外安装解析器。

```ts
import { defineRule, defineRules, oxcRule } from 'vue-doctor/rules'

export const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: {
        title: '使用块级作用域声明',
        description: '使用 let 或 const 声明变量。',
        domain: 'conventions',
        defaultSeverity: 'warning'
      },
      check: oxcRule({
        create(context) {
          return {
            VariableDeclaration(node) {
              if (node.kind === 'var') {
                context.report({ node, message: '请使用 let 或 const。' })
              }
            }
          }
        }
      })
    }),
    'no-debugger': defineRule({
      meta: {
        title: '移除 debugger 语句',
        description: '不要提交 debugger 语句。',
        domain: 'conventions',
        defaultSeverity: 'error'
      },
      check: oxcRule({
        create(context) {
          return {
            DebuggerStatement(node) {
              context.report({ node, message: '请移除此 debugger 语句。' })
            }
          }
        }
      })
    })
  }
})
```

## 导入并注册规则包

在模块旁边保存可执行配置 `doctor.config.ts`：

```ts
import { defineDoctorConfig } from 'vue-doctor'
import { teamRules } from './doctor-rules.ts'

export default defineDoctorConfig({
  rulePacks: [teamRules],
  rules: {
    'team/no-var': 'warning',
    'team/no-debugger': 'error'
  }
})
```

`defineRule` 定义单条检查，`oxcRule` 提供脚本 AST visitor，`defineRules` 将它们组合成一个导出的规则包。规则包名与对象 key 生成完整 code `team/no-var` 和 `team/no-debugger`。在 `rules` 中用完整 code 设置 `error`、`warning`、`info` 或 `off`。自定义规则接入已有规则目录、局部抑制审计和覆盖率门禁。`config.rules` 中出现未注册的 code 会直接报配置错误，即使严重度设为 `off` 也一样。

跨项目共享时，从自建包的公开入口导出 `teamRules`，消费项目在配置中导入该导出，替代相对路径模块。消费项目需要可以解析 `vue-doctor`；可复用规则包应将兼容版本的 `vue-doctor` 声明为 peer dependency。使用公开的 `vue-doctor/rules` 入口，不依赖工作区源码路径。Doctor 不会安装或下载规则包，项目必须已经能够解析对应包。

配置与导入的规则包属于受信任的可执行代码，JSON 配置不能导入执行函数。每个导入的规则包都必须放入 `rulePacks`，仅 import 不会启用。API 内联传入的 `rulePacks` 替换文件配置列表，传 `[]` 可禁用外部规则包。

私有策略应保存在公开仓库之外，例如单独分发的私有包或外部本地模块。如需放在 checkout 中，策略模块和私有配置都应保持未被跟踪，并在本地忽略（例如通过 `.git/info/exclude`）。忽略已跟踪的文件不会将它从发布内容或历史记录中移除。公开发布时仅保留中性的示例，不包含凭据、私有包名或内部路径。

## 触发两条检查

在临时消费项目中创建 `src/rule-demo.ts`：

```ts
var attempts = 0
debugger
export { attempts }
```

然后执行：

```bash
./node_modules/.bin/vue-doctor --config ./doctor.config.ts --scope src/rule-demo.ts --json
pnpm exec vue-doctor rules explain team/no-debugger --config ./doctor.config.ts
```

示例应产生带源码位置的 `team/no-var` warning 与 `team/no-debugger` error。其他已启用检查仍可能产生诊断或覆盖缺口。将 `var` 改为 `let`，并删除 `debugger`，即可修复这两条诊断；这不代表整体覆盖已完整。这些是教学用的小规则，已有 ESLint 规则满足需求时应优先复用。

## 解析后端与证据

`oxcRule` 使用 Oxc 的 ESTree/TS-ESTree 节点。visitor 的 key 为 `VariableDeclaration` 等节点名，也支持 `VariableDeclaration:exit`；更细的匹配条件写在回调中。该适配器不支持任意 ESLint selector 字符串。支持 JS、TS、JSX、TSX 和 Vue 内联脚本块。`context.text(node)` 读取原始块文本，`context.location(node)` 将 UTF-16 偏移映射为完整文件的一基行列。AST 修改只作用于当前规则，不修改项目源码，也不传播到其他规则。

需要 Babel 语法插件或原生 Babel visitor 时，使用 `babelRule`。回调收到 `NodePath`，可通过 `path.scope.getBinding(name)` 查询词法绑定；需要作用域时声明 `requires: { scope: true }`，额外语法通过 `parserOptions.plugins` 启用。Babel 与 Oxc 的节点结构不同。Vue 的每个内联脚本块拥有独立的遍历和词法作用域。Babel 后端要求 Node `^22.18.0 || >=24.11.0`，仅在选用时加载；Oxc 规则保留 Vue Doctor 现有的 Node 支持范围。

`requires` 支持声明 `syntax`、`scope`、`types` 能力。Oxc 提供语法分析，Babel 提供语法与词法作用域分析；两个适配器都不提供 TypeScript 项目类型检查器，请求 `types` 会记录必需能力缺失。已有模板规则和类型规则继续使用各自的专用引擎。解析器需要显式选择，语法错误不会触发自动切换。源码缺失、外部脚本块、不支持的语言、解析失败或规则回调异常都会产生必需跳过记录，并影响覆盖率。

规则元数据还可以通过 `meta.requires` 声明源代码块和 Vue 版本证据要求。脚本适配器无法提供组件归属和契约证据，相关要求会产生必需跳过记录。声明为 `manual`、`runtime` 或 `policy-pending` 的规则保留对应验证状态，AST 遍历不会完成这些验收检查。

需要 ESLint selector、注释、词法 scope、Vue template parser services 或项目类型信息时，从 `vue-doctor/rules-eslint` 使用 ESTree 适配器：

```ts
import { defineRule, defineRules } from 'vue-doctor/rules'
import { estreeRule } from 'vue-doctor/rules-eslint'

const teamRules = defineRules({
  name: 'team',
  rules: {
    'no-var': defineRule({
      meta: { title: '使用块级作用域声明', description: '使用 let 或 const。' },
      check: estreeRule({
        meta: { schema: [] },
        create(context) {
          return {
            'VariableDeclaration[kind="var"]'(node) {
              context.report({ node, message: '请使用 let 或 const。' })
            }
          }
        }
      })
    })
  }
})
```

`eslintRule({ module, options, typed: true })` 可接入官方 RuleModule 或需要类型的检查；类型检查必须有消费项目的 `tsconfig.json` 或 `jsconfig.json`，并使用真实的 TypeScript program 和节点映射。Vue 模板服务使用 `vue-eslint-parser` AST；SFC 描述与脚本原文由 Vue compiler-sfc 提取。这个路径支持现有 Node 20 基线及 Vue 2.7／3。

同一个 ESLint engine 在一次运行中批量执行独立规则，每个文件最多一轮普通检查和一轮类型检查。ESTree 规则共享该轮解析上下文，应该只读 AST；Oxc／Babel 的每条规则仍使用独立 AST 副本。更特殊的图分析、原始字节或其他解析器可以用 `defineRuleEngine` 与 `engineRule` 接入同一个 `defineRules`：每条规则仍要返回独立的执行记录，异常、缺失记录或非法结果会留下必需跳过记录。
