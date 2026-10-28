# Inspector

[Quick start](../../README.md) · [Guide](./README.md) · [简体中文](./inspector.zh-CN.md)

## Start the Inspector

Use `--inspect` when you want to explore the result in a browser:

```bash
vue-doctor --inspect
```

Vue Doctor runs the check, starts an Inspector on the loopback interface, opens it in the default browser, and prints its URL. The process stays alive while the Inspector is available. Press `Ctrl+C` in the terminal to stop it.

The Inspector and its report endpoint are served only by this local process; they are not application routes and are not added to the application bundle.

## Views and rescanning

The Inspector uses Hub UI to host one Doctor workspace with Findings, Coverage, Rules and Audit views. Findings and evidence load on demand; search covers the complete report and returns 100 findings per page. All views read the same immutable snapshot. Browsing, filtering and paging do not start a scan. Choose **Run again** to request a new analysis; a failed run keeps the last completed report available. Audit lists applied, invalid and unused local suppression directives, including their reasons and original findings.

Select VS Code, Cursor or WebStorm beside a finding, then choose **Open source** to navigate to its source location.

### Search, filters, and keyboard

- Findings filters combine search, severity, domain, confidence, rule, package, and optional suggestions. On narrow screens, expand **Filters** to access the same controls; its count shows active filters. **Clear filters** restores the full result set and returns focus to search.
- Rules has a dedicated search and execution-status filter. Selecting a rule shows its available metadata and finding count; a checked rule with zero findings is not the same as an unavailable or disabled rule.
- Press `/` outside a text field to focus the current view's search. Use Up/Down in findings and rule lists; rule lists also support Home/End. Detail tabs support Left/Right and Home/End.
- The header switches language and dark/light theme. The initial theme follows the system, and an explicit choice is remembered. Icons are bundled locally; the workspace does not need an external icon service.

Incomplete coverage remains visible while browsing, including when no findings match the current filters. Review Coverage before treating an empty result as clean.

## Host integrations

When a Vite DevTools host is installed, the same Doctor workspace registers with that host. Without one, Vite serves an independent Inspector at `/vue-doctor/`. CLI Inspector also works with Vue CLI and persisted reports, without a Vite dependency in the consuming project. The legacy JSON report endpoint remains available for local integrations; fetching that endpoint with an analysis provider still refreshes its report. Legacy report, snippet and editor APIs accept same-origin loopback requests; remote hosts use the authenticated Doctor workspace.

## Git attribution

When line-level source evidence belongs to a Git repository, Doctor Run adds the latest blame author, commit, authored time, and commit summary. The Inspector shows this context beside the source snippet, which helps route a finding to the developer familiar with that line. Reports do not include author email; untracked files, unavailable history, and Git failures leave attribution empty without blocking diagnosis. Set `gitAttribution: false` in Doctor config when author names and commit summaries should not be collected or written to CI reports.
