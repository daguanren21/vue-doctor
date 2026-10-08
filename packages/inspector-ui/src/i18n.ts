export type InspectorLocale = 'en' | 'zh'

export const inspectorMessages = {
  en: {
    title: 'Vue Doctor',
    inspector: 'Inspector',
    doctorRun: 'Doctor Run',
    selectedFinding: 'Selected finding',
    overview: 'Overview',
    allFindings: 'All findings',
    severity: 'Severity',
    errors: 'Errors',
    warnings: 'Warnings',
    info: 'Info',
    coverage: 'Coverage',
    ruleCoverage: 'Rule execution and acceptance',
    ruleCoverageHint: 'Checked means evaluated, not necessarily passed. Runtime, manual and pending checks are not proof of compliance.',
    searchCoverage: 'Search rules and acceptance checks',
    checkStatus: 'Check status',
    checkAll: 'All statuses',
    checkChecked: 'Checked',
    checkPartial: 'Partly checked',
    runDetails: 'Run target and context',
    runTarget: 'Target',
    runFiles: 'files',
    runPackages: 'consuming packages',
    runApplications: 'applications',
    contextIssues: 'Application context issues',
    suppressionAudit: 'Suppression audit',
    suppressionApplied: 'Applied',
    suppressionUnused: 'Unused',
    suppressionInvalid: 'Invalid',
    suppressionHint: 'Suppressed findings remain here for review. Suppression does not change coverage or skipped checks.',
    suppressionReason: 'Reason',
    editPreview: 'Proposed text edits',
    suggestionOnly: 'Remediation suggestions; no files are changed.',
    checkNotApplicable: 'Not applicable',
    checkUnavailable: 'Missing evidence',
    checkManual: 'Manual review',
    checkRuntime: 'Runtime verification',
    checkPolicyPending: 'Policy pending',
    checkDisabled: 'Disabled',
    checkUnreported: 'Not reported',
    noRuleCoverage: 'This report contains no per-rule execution records.',
    noCoverageMatches: 'No rules match these filters.',
    showRuleFindings: 'Show rule findings',
    standards: 'Standard clauses',
    prerequisite: 'Evidence or acceptance requirement',
    previous: 'Previous',
    next: 'Next',
    category: 'Problem domain',
    styles: 'CSS / styles',
    interaction: 'Interaction',
    vite: 'Vite',
    conventions: 'Conventions',
    unclassified: 'Unclassified',
    domainCoverage: 'Domain coverage',
    domainNotCovered: 'Not covered',
    domainNotReported: 'Execution not reported',
    domainPartial: 'Incomplete / pending',
    domainComplete: 'Execution complete',
    domainRules: 'Rules',
    domainPending: 'Pending',
    domainCoverageHint: 'Domains classify problems. Execution groups and rule packs remain separate. An empty domain does not prove compliance.',
    tags: 'Tags',
    rulePack: 'Rule pack',
    discoveryIssues: 'Source discovery issues',
    vueWriting: 'Vue syntax / API',
    componentLibrary: 'Component library',
    otherFindings: 'Other',
    allCategories: 'All categories',
    styleSuggestions: 'Suggestions',
    showStyleSuggestions: 'Show suggestions',
    hideStyleSuggestions: 'Hide suggestions',
    styleSuggestionsToggle: 'Suggestions',
    styleSuggestionsHint: 'Hidden by default: prefer-use-template-ref, prefer-define-model.',
    findings: 'Findings',
    evidence: 'Evidence',
    clearFilters: 'Clear filters',
    openIn: 'Open in',
    openFile: 'Open file',
    source: 'Source',
    package: 'Installed package',
    packageFilter: 'Package',
    remediation: 'Remediation',
    suggestedFix: 'Suggested fix',
    consumer: 'Consumer',
    contractProvenance: 'Contract provenance',
    evidenceLocations: 'Evidence locations',
    gitAttribution: 'Last commit',
    gitCommit: 'commit',
    gitUncommitted: 'Uncommitted',
    sourceSnippet: 'Source',
    noContractSources: 'No contract sources recorded for this package.',
    noAutomaticFix: 'No automatic fix — see the Rule tab for context.',
    confidence: 'confidence',
    declaredVersion: 'declared',
    copy: 'Copy',
    whyThisFired: 'Why this fired',
    relatedCoverage: 'Related coverage',
    rule: 'Rule',
    ready: 'Ready',
    refreshing: 'Refreshing…',
    projectNameFallback: 'project',
    libraries: 'libraries',
    skippedCount: 'skipped',
    coverageComplete: 'complete',
    coveragePartial: 'partial',
    coverageBlocked: 'blocked',
    themeToggle: 'Toggle theme',
    language: 'Language',
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    runAgain: 'Run again',
    collapse: 'Collapse filters',
    expand: 'Expand filters',
    search: 'Search findings',
    loading: 'Loading report',
    loadingHint: 'Fetching the latest Doctor Run inventory and diagnostics.',
    reportUnavailable: 'Report unavailable',
    reportUnavailableTitle: 'Could not load the Doctor report',
    reportUnavailableHint: 'The Inspector could not fetch report data. Retry after the analysis server is ready.',
    analysisComplete: 'Analysis complete',
    coverageStatus: 'Coverage',
    selectFinding: 'Select a finding to inspect its evidence.',
    selectFindingTitle: 'No finding selected',
    selectFindingHint: 'Pick a diagnostic from the list to inspect source evidence, package contracts, and remediation.',
    noSelection: 'No finding selected',
    noSourceFile: 'No source file',
    systemDefault: 'System default',
    noMatches: 'No findings match these filters',
    noMatchesHint: 'Clear search or filters to show report findings.',
    cleanTitle: 'No diagnostics reported',
    cleanHint: 'This Doctor Run reported no diagnostics. Review domain coverage for unverified areas.',
    incompleteEmptyTitle: 'No findings can be confirmed',
    incompleteEmptyHint: 'Review analysis coverage before treating this empty result as clean.',
    reviewCoverage: 'Review coverage',
    retry: 'Retry',
    incompleteNotice: 'Analysis coverage is incomplete. Review coverage before treating an empty result as clean.',
    editorUnavailable: 'The editor could not be opened.',
    waitingProject: 'Waiting for project inventory',
    findingsCount: 'findings',
    filters: 'Filters',
    openFilters: 'Open filters',
    closeFilters: 'Close filters',
    refreshReport: 'Refresh report'
    ,navigation: 'Inspector views'
    ,rules: 'Rules'
    ,audit: 'Audit'
    ,searchRules: 'Search rules'
    ,searchAudit: 'Search suppression audit'
    ,searchPlaceholder: 'Search message, rule, file or package'
    ,connectionFailed: 'Could not connect to the analysis host'
    ,connectionFailedHint: 'Check that the Inspector host is running, then reconnect.'
    ,reconnect: 'Reconnect'
    ,staleReport: 'Showing the last completed report'
    ,staleReportHint: 'A new analysis is running or the connection was interrupted. The visible evidence remains from the previous snapshot.'
    ,runFailed: 'The latest analysis failed'
    ,exportReport: 'Export JSON'
    ,exporting: 'Exporting…'
    ,snapshot: 'Snapshot'
    ,createdAt: 'Created'
    ,project: 'Project'
    ,framework: 'Framework'
    ,all: 'All'
    ,domain: 'Domain'
    ,confidenceLabel: 'Confidence'
    ,confidenceHigh: 'High'
    ,confidenceMedium: 'Medium'
    ,confidenceLow: 'Low'
    ,searchPackages: 'Search packages'
    ,noSelectMatches: 'No matching options'
    ,suggestions: 'Suggestions'
    ,showSuggestions: 'Include optional style suggestions'
    ,resultRange: 'Result range'
    ,pageUnavailable: 'Could not load this page'
    ,pageUnavailableHint: 'The previous page remains visible. Retry the current query.'
    ,detailUnavailable: 'Could not load finding evidence'
    ,noCoverageItems: 'No coverage gaps match these filters.'
    ,coverageIntro: 'Coverage records the evidence Vue Doctor could not prove. A blocked or partial run must not be treated as clean.'
    ,parseGaps: 'Parse gaps'
    ,contextGaps: 'Context gaps'
    ,contractGaps: 'Contract gaps'
    ,skippedChecks: 'Skipped checks'
    ,sourceGaps: 'Source gaps'
    ,domainGaps: 'Domain gaps'
    ,ruleStatusHint: 'Checked means evaluated. Runtime, manual, unavailable and policy-pending rules still require evidence.'
    ,coreRules: 'Core rules'
    ,findingCount: 'Finding count'
    ,verification: 'Verification'
    ,skipReason: 'Why this was not checked'
    ,noRules: 'No rules match these filters.'
    ,auditIntro: 'Local suppressions remain visible with the original diagnostics, directive location, reason and validity.'
    ,originalDiagnostics: 'Original diagnostics'
    ,directive: 'Directive'
    ,mode: 'Mode'
    ,status: 'Status'
    ,noAudit: 'No suppression records match these filters.'
    ,invalidDirective: 'Invalid directive'
    ,unusedDirective: 'Unused directive'
    ,appliedDirective: 'Applied suppression'
    ,details: 'Details'
    ,sourceCode: 'Source code'
    ,fixes: 'Suggestions'
    ,ruleContext: 'Rule context'
    ,noSnippet: 'No source snippet is available for this finding.'
    ,noEvidence: 'No additional evidence was recorded.'
    ,noSuggestions: 'No automated suggestion was recorded.'
    ,location: 'Location'
    ,openSource: 'Open source'
    ,loadingDetails: 'Loading evidence…'
    ,currentPage: 'Current page'
    ,selectRule: 'Select a rule to inspect its execution status.'
    ,selectAudit: 'Select an audit record to inspect the original diagnostic.'
    ,reportClean: 'No findings with complete coverage'
    ,reportCleanHint: 'This snapshot reported no findings and completed all configured analysis coverage.'
    ,notClean: 'No findings, but coverage is incomplete'
    ,notCleanHint: 'Review coverage gaps before accepting this result.'
  },
  zh: {
    title: 'Vue Doctor',
    inspector: '检查器',
    doctorRun: '诊断任务',
    selectedFinding: '当前诊断',
    overview: '概览',
    allFindings: '全部诊断',
    severity: '严重程度',
    errors: '错误',
    warnings: '警告',
    info: '提示',
    coverage: '覆盖率',
    ruleCoverage: '规则执行与验收',
    ruleCoverageHint: '“已检查”表示已执行判断，不代表没有问题。运行时、人工及待定项均不代表规范已通过。',
    searchCoverage: '搜索规则与验收项目',
    checkStatus: '检查状态',
    checkAll: '全部状态',
    checkChecked: '已检查',
    checkPartial: '部分已检查',
    runDetails: '运行目标与上下文',
    runTarget: '目标',
    runFiles: '个文件',
    runPackages: '个消费包',
    runApplications: '个应用',
    contextIssues: '应用上下文问题',
    suppressionAudit: '抑制审计',
    suppressionApplied: '已应用',
    suppressionUnused: '未命中',
    suppressionInvalid: '无效',
    suppressionHint: '被抑制的诊断保留在此供复核。抑制不改变覆盖状态和跳过的检查。',
    suppressionReason: '原因',
    editPreview: '建议文本编辑',
    suggestionOnly: '以下为修复建议，不会修改文件。',
    checkNotApplicable: '不适用',
    checkUnavailable: '缺少证据',
    checkManual: '需人工审查',
    checkRuntime: '需运行时验证',
    checkPolicyPending: '规范待定',
    checkDisabled: '未启用',
    checkUnreported: '未报告',
    noRuleCoverage: '此报告未记录逐项规则执行状态。',
    noCoverageMatches: '没有匹配的规则。',
    showRuleFindings: '查看此规则的诊断',
    standards: '规范条目',
    prerequisite: '证据或验收要求',
    previous: '上一页',
    next: '下一页',
    category: '问题领域',
    styles: 'CSS / 样式',
    interaction: '交互行为',
    vite: 'Vite',
    conventions: '规范建议',
    unclassified: '未分类',
    domainCoverage: '领域覆盖',
    domainNotCovered: '未覆盖',
    domainNotReported: '未记录执行状态',
    domainPartial: '缺少证据 / 待验收',
    domainComplete: '执行完整',
    domainRules: '规则',
    domainPending: '待验收',
    domainCoverageHint: '领域用于归类问题，执行分组与规则包各自保留。没有诊断不代表该领域已通过。',
    tags: '标签',
    rulePack: '规则包',
    discoveryIssues: '源码发现问题',
    vueWriting: 'Vue 语法 / API',
    componentLibrary: '组件库契约',
    otherFindings: '其他',
    allCategories: '全部类别',
    styleSuggestions: '规范建议',
    showStyleSuggestions: '显示规范建议',
    hideStyleSuggestions: '隐藏规范建议',
    styleSuggestionsToggle: '规范建议',
    styleSuggestionsHint: '默认隐藏：prefer-use-template-ref、prefer-define-model。',
    findings: '诊断',
    evidence: '证据',
    clearFilters: '清除筛选',
    openIn: '打开方式',
    openFile: '在编辑器中打开',
    source: '源码',
    package: '安装包',
    packageFilter: '依赖包',
    remediation: '修复建议',
    suggestedFix: '修复建议',
    consumer: '消费方',
    contractProvenance: '契约来源',
    evidenceLocations: '证据位置',
    gitAttribution: '最近提交',
    gitCommit: '提交',
    gitUncommitted: '未提交',
    sourceSnippet: '源码片段',
    noContractSources: '该包未记录契约来源。',
    noAutomaticFix: '没有自动修复建议，请查看规则页了解上下文。',
    confidence: '置信度',
    declaredVersion: '声明版本',
    copy: '复制',
    whyThisFired: '触发原因',
    relatedCoverage: '相关覆盖',
    rule: '规则',
    ready: '就绪',
    refreshing: '刷新中…',
    projectNameFallback: '项目',
    libraries: '个库',
    skippedCount: '跳过',
    coverageComplete: '完整',
    coveragePartial: '部分',
    coverageBlocked: '阻塞',
    themeToggle: '切换主题',
    language: '语言',
    collapseSidebar: '收起侧栏',
    expandSidebar: '展开侧栏',
    runAgain: '重新运行',
    collapse: '收起筛选',
    expand: '展开筛选',
    search: '搜索诊断',
    loading: '正在加载报告',
    loadingHint: '正在获取最新的 Doctor Run 清单与诊断结果。',
    reportUnavailable: '报告不可用',
    reportUnavailableTitle: '无法加载 Doctor 报告',
    reportUnavailableHint: '检查器未能获取报告数据。请在分析服务就绪后重试。',
    analysisComplete: '分析完成',
    coverageStatus: '覆盖率',
    selectFinding: '选择一条诊断以查看证据。',
    selectFindingTitle: '未选择诊断',
    selectFindingHint: '从列表中选择一条诊断，查看源码证据、安装包契约与修复建议。',
    noSelection: '未选择诊断',
    noSourceFile: '无源码文件',
    systemDefault: '系统默认',
    noMatches: '没有匹配的诊断',
    noMatchesHint: '清除搜索或筛选条件以显示诊断。',
    cleanTitle: '未报告诊断',
    cleanHint: '本次诊断任务没有报告问题，请查看领域覆盖了解尚未验证的部分。',
    incompleteEmptyTitle: '无法确认诊断结果',
    incompleteEmptyHint: '请先检查分析覆盖情况，再将空结果视为干净。',
    reviewCoverage: '查看覆盖',
    retry: '重试',
    incompleteNotice: '分析覆盖不完整。请先检查覆盖情况，再判断结果是否干净。',
    editorUnavailable: '无法打开所选编辑器。',
    waitingProject: '等待项目清单',
    findingsCount: '条诊断',
    filters: '筛选',
    openFilters: '打开筛选',
    closeFilters: '关闭筛选',
    refreshReport: '刷新报告'
    ,navigation: '检查器视图'
    ,rules: '规则'
    ,audit: '审计'
    ,searchRules: '搜索规则'
    ,searchAudit: '搜索抑制审计'
    ,searchPlaceholder: '搜索消息、规则、文件或依赖包'
    ,connectionFailed: '无法连接分析宿主'
    ,connectionFailedHint: '请确认 Inspector 宿主仍在运行，然后重新连接。'
    ,reconnect: '重新连接'
    ,staleReport: '当前显示上一次完成的报告'
    ,staleReportHint: '新分析正在运行，或连接已经中断；当前证据仍来自旧快照。'
    ,runFailed: '最近一次分析失败'
    ,exportReport: '导出 JSON'
    ,exporting: '正在导出…'
    ,snapshot: '快照'
    ,createdAt: '生成时间'
    ,project: '项目'
    ,framework: '框架'
    ,all: '全部'
    ,domain: '领域'
    ,confidenceLabel: '置信度'
    ,confidenceHigh: '高'
    ,confidenceMedium: '中'
    ,confidenceLow: '低'
    ,searchPackages: '搜索依赖包'
    ,noSelectMatches: '没有匹配的选项'
    ,suggestions: '建议'
    ,showSuggestions: '包含可选风格建议'
    ,resultRange: '结果范围'
    ,pageUnavailable: '无法加载当前页面'
    ,pageUnavailableHint: '上一页数据仍然保留，可以重试当前查询。'
    ,detailUnavailable: '无法加载诊断证据'
    ,noCoverageItems: '没有匹配的覆盖缺口。'
    ,coverageIntro: '覆盖记录 Vue Doctor 无法证明的证据。覆盖受阻或不完整时，不能把结果视为干净。'
    ,parseGaps: '解析缺口'
    ,contextGaps: '上下文缺口'
    ,contractGaps: '契约缺口'
    ,skippedChecks: '跳过检查'
    ,sourceGaps: '源码缺口'
    ,domainGaps: '领域缺口'
    ,ruleStatusHint: '“已检查”只表示执行过判断。运行时、人工、证据不足和规范待定仍需要验证。'
    ,coreRules: '核心规则'
    ,findingCount: '诊断数'
    ,verification: '验证方式'
    ,skipReason: '未完成检查的原因'
    ,noRules: '没有匹配的规则。'
    ,auditIntro: '局部抑制会连同原始诊断、指令位置、原因和有效性一起保留。'
    ,originalDiagnostics: '原始诊断'
    ,directive: '抑制指令'
    ,mode: '模式'
    ,status: '状态'
    ,noAudit: '没有匹配的抑制审计记录。'
    ,invalidDirective: '无效指令'
    ,unusedDirective: '未命中指令'
    ,appliedDirective: '已应用抑制'
    ,details: '详情'
    ,sourceCode: '源码'
    ,fixes: '修复建议'
    ,ruleContext: '规则上下文'
    ,noSnippet: '当前诊断没有可用的源码片段。'
    ,noEvidence: '当前诊断没有记录额外证据。'
    ,noSuggestions: '当前诊断没有自动修复建议。'
    ,location: '位置'
    ,openSource: '打开源码'
    ,loadingDetails: '正在加载证据…'
    ,currentPage: '当前页'
    ,selectRule: '选择一条规则以查看执行状态。'
    ,selectAudit: '选择一条审计记录以查看原始诊断。'
    ,reportClean: '未发现诊断，且覆盖完整'
    ,reportCleanHint: '此快照未报告诊断，并完成了所有已配置的分析覆盖。'
    ,notClean: '未发现诊断，但覆盖不完整'
    ,notCleanHint: '请先检查覆盖缺口，再决定是否接受结果。'
  }
} as const

export type InspectorMessages = { [Key in keyof typeof inspectorMessages.en]: string }

export function defaultInspectorLocale(language: string | undefined): InspectorLocale {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
