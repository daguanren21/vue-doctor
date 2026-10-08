# MCP 与 Agent

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./mcp.md)

## MCP 连接

Vue Doctor 通过 Devframe MCP 提供诊断能力。Agent 与 Inspector 读取同一个已完成快照，可以查看诊断和源码证据、检查覆盖率与抑制审计，并显式请求重新扫描。工具运行在 Node 端，关闭浏览器页面后仍然可用。

CLI Inspector 或 Vite 宿主已运行时，使用 Devframe connector：

```json
{
  "mcpServers": {
    "devframe": {
      "command": "npx",
      "args": ["-y", "--package=devframe", "--package=@devframes/agentic", "devframe", "connect"]
    }
  }
}
```

先调用 `devframe_connect_list-instances`，选择目标项目实例，再通过 `devframe_connect_call-tool` 传入端口、工具名和参数。独立 Inspector 会登记实例，并在 `/vue-doctor/__mcp` 提供 MCP。接入原生 Vite DevTools Hub 时，实例发现、MCP endpoint 和认证由宿主管理。自定义挂载 base 时，MCP 路径也随之变化。Connector 会自动携带所需的 `Origin` header，直接调用 HTTP 的客户端也需传入实例的 origin。

项目没有运行 Inspector 或 dev server 时，构建本仓库，并将独立 stdio 入口指向构建后的 CLI：

```json
{
  "mcpServers": {
    "vue-doctor": {
      "command": "node",
      "args": ["/absolute/path/to/vue-doctor/packages/vue-doctor/dist/cli.mjs", "mcp", "/path/to/project"]
    }
  }
}
```

`vue-doctor mcp <root>` 持有分析会话，直到 MCP 客户端断开。可添加 `--scope src` 或 `--config /path/to/vue-doctor.config.ts` 来限制扫描范围或指定配置。它不会打开浏览器；stdout 只传输 MCP 消息，运行错误写入 stderr。

先读 `vue-doctor_help` 和 `vue-doctor_get-overview`，后续查询携带返回的 `snapshotId`；快照过期时重新读取概览。MCP 实际提供以下工具名：

| 用途 | 工具 |
| --- | --- |
| 使用指引与概览 | `vue-doctor_help`、`vue-doctor_get-overview` |
| 诊断与源码 | `vue-doctor_list-findings`、`vue-doctor_get-finding`、`vue-doctor_get-source-context` |
| 覆盖与规则 | `vue-doctor_get-coverage`、`vue-doctor_list-rules` |
| 抑制审计 | `vue-doctor_list-suppressions`、`vue-doctor_get-suppression` |
| 修复验证 | `vue-doctor_rescan`、`vue-doctor_get-last-scan-diff` |

资源 `devframe://resource/vue-doctor%3Ahelp` 和 `devframe://resource/vue-doctor%3Aoverview` 提供工作流和当前概览，调用时使用 discovery 返回的 URI。列表与证据分页返回，过长内容带截断信息。筛选后零结果不代表项目干净：只有有效诊断为零且覆盖完整，才能判定 clean。

MCP 工具负责诊断，不应用源码编辑、不打开编辑器，也不把完整报告塞进 Agent 上下文。Agent 使用自己的文件工具完成已授权修改，再显式重扫。返回结果比较前后快照中的诊断和覆盖情况；并发重扫共用分析，失败保留上一次完成的快照。最近一次成功比较在重新连接后仍可查询。需要完整、可保存的产物时，使用 CLI JSON 报告。

## 安装 Agent Skill

将本仓库构建后的包链接到消费项目后，把其内置 skill 安装到本地 coding agents：

```bash
pnpm exec vue-doctor install
pnpm exec vue-doctor install --agent claude-code --agent cursor
pnpm exec vue-doctor install --all-agents
pnpm exec vue-doctor install agents
```

命令会把内置 `vue-doctor` skill 复制到各 agent 的 skills 目录，方便改完代码后按统一流程排查 Vue Doctor 诊断。
