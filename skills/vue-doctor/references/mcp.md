# Vue Doctor through MCP

Use this workflow when Doctor tools are connected, directly through stdio or through a running Devframe host.

## Select the project and read the available capabilities

With `devframe connect`, call `devframe_connect_list-instances` and identify the intended project from its root and instance metadata. Invoke its tools using `devframe_connect_call-tool` and the selected port. Keep that project selection throughout the task. Direct stdio is already bound to the root used to start `vue-doctor mcp <root>`.

Read `vue-doctor_help` and `vue-doctor_get-overview` before proposing a fix. Use the actual tool names and schemas from discovery; hosts may namespace them. Resources `devframe://resource/vue-doctor%3Ahelp` and `devframe://resource/vue-doctor%3Aoverview` provide the same workflow and current summary; read the exact URIs advertised by discovery. The overview identifies the project, completed `snapshotId`, run state, finding counts and coverage. Reads inspect an existing snapshot and do not refresh source analysis.

If the intended instance is absent, explain that the host must be running or use the CLI/report workflow. An open browser is not required for Doctor's Node tools. Do not select an unrelated project to make a tool available.

## Investigate a completed snapshot

1. Check coverage and required skipped checks. A zero-result filter or zero active findings with partial/blocked coverage is incomplete knowledge.
2. Query findings within the user's scope, starting with relevant errors and high-confidence warnings. Page through results as needed.
3. Read finding detail and cited evidence; obtain source context using its finding ID.
4. Inspect installed component-library evidence when the finding concerns an API contract. Unverified acceptance remains unresolved evidence.
5. Use rule metadata and suppression audit to explain policy or intentional exclusions. Do not count suppressed findings as fixes.

Pass the overview's `snapshotId` to snapshot-bound queries. On a stale-snapshot error, refresh the overview and repeat the affected query. Do not combine records from different snapshots. Observe pagination and truncation metadata; an omitted or truncated item is not evidence that it does not exist. Advance list offsets by `returned`, and evidence or audit offsets by their actual returned counts, because the response byte budget can reduce a requested page.

## Fix and verify

Doctor MCP does not write source. Use the agent's file tools for changes within the user's authorized scope. Then explicitly request a rescan with the current snapshot ID. Do not silently switch to a broader root or scan scope.

Read the completed new snapshot and the before/after comparison. Confirm that intended findings are resolved, inspect added or changed findings, and check coverage and required skips. A reduction caused by configuration changes or suppression is not proof of a source fix. A bounded comparison sample is not the complete set; query the new snapshot when more detail is needed.

If rescan fails, the previous successful snapshot remains available. Report the failure and do not claim the changed source was verified. On reconnect, the latest successful comparison can help recover the workflow, but it does not replace the task's own before/after evidence.

Report each fix with the rule code, source location, evidence, before/after snapshot IDs and coverage. Retain explicit hold/info/coverage classifications for findings outside the requested change. Use a CLI JSON export when the user needs a complete saved report.
