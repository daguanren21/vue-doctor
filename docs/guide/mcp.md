# MCP and agents

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./mcp.zh-CN.md)

## MCP connection

Vue Doctor exposes diagnostics through Devframe MCP. An agent reads the same completed snapshot as the Inspector, inspects findings and source evidence, reviews coverage and suppression audit, and explicitly requests another scan. These tools run in Node and remain available when the browser page is closed.

For a running CLI Inspector or Vite host, use the Devframe connector:

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

Call `devframe_connect_list-instances`, select the project's instance, then use `devframe_connect_call-tool` with its port, tool name and arguments. Independent Inspector hosts publish their instance and serve MCP at `/vue-doctor/__mcp`. In a native Vite DevTools hub, discovery, the MCP endpoint and authentication belong to that host. A custom mount base also changes the MCP path. The connector supplies the required `Origin` header; direct HTTP clients must send the instance's origin too.

For a project without a running Inspector or dev server, build this checkout and point the headless stdio entry at its CLI:

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

`vue-doctor mcp <root>` owns its analysis session until the MCP client disconnects. Add `--scope src` or `--config /path/to/vue-doctor.config.ts` to constrain the scan or select its configuration. It does not open a browser; stdout carries only MCP messages and operational errors go to stderr.

Start with `vue-doctor_help` and `vue-doctor_get-overview`. Keep the returned `snapshotId` for subsequent queries; if it becomes stale, read the overview again. The tool names advertised by MCP are:

| Purpose | Tools |
| --- | --- |
| Orientation | `vue-doctor_help`, `vue-doctor_get-overview` |
| Diagnostics and source | `vue-doctor_list-findings`, `vue-doctor_get-finding`, `vue-doctor_get-source-context` |
| Coverage and policy | `vue-doctor_get-coverage`, `vue-doctor_list-rules` |
| Suppression audit | `vue-doctor_list-suppressions`, `vue-doctor_get-suppression` |
| Verification | `vue-doctor_rescan`, `vue-doctor_get-last-scan-diff` |

Resources `devframe://resource/vue-doctor%3Ahelp` and `devframe://resource/vue-doctor%3Aoverview` provide the workflow and current summary. Use the resource URIs returned by discovery. Lists and evidence are paginated, and long content includes truncation metadata. Empty filtered results do not imply a clean project: zero active findings require complete coverage before the result can be called clean.

The MCP tools inspect diagnostics; they do not apply edits, open an editor, or export the complete report into the agent's context. The agent makes an authorized source change with its own file tools, then explicitly rescans. The result compares the previous and new snapshots, including finding changes and coverage. Concurrent rescans share work, and a failed scan retains the last completed snapshot. The latest successful comparison remains queryable after reconnecting. Use the CLI JSON report when a complete, durable artifact is needed.

## Install the agent skill

After linking this checkout's built package into the consuming project, install its bundled skill into local coding agents:

```bash
pnpm exec vue-doctor install
pnpm exec vue-doctor install --agent claude-code --agent cursor
pnpm exec vue-doctor install --all-agents
pnpm exec vue-doctor install agents
```

This copies the bundled `vue-doctor` skill into each agent skills directory so agents can triage Vue Doctor findings consistently after code changes.
