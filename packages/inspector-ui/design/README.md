# Vue Doctor Inspector — UI Design

A local, evidence-first diagnostics workbench. Preserve the Probe V mark and Vue green identity; do not turn diagnostic data into a marketing dashboard.

## Direction and source of truth

The [ESLint Config Inspector](https://github.com/eslint/config-inspector) informs the prominent rule search, restrained separators, and readable rule identifiers. Vue Doctor retains its own Findings → evidence workflow, coverage model, themes, and navigation.

The implemented design lives in:

- `src/assets/tailwind.css`: semantic dark/light colors, focus, typography, and reduced motion.
- `src/lib/variants.ts`: shared buttons and diagnostic badges.
- `src/lib/icons.ts`: the locally bundled Lucide icon inventory.
- `src/components/workspace/`: project header, view navigation, selects, status badges, pagination.
- `src/components/findings/`: filters, results, and evidence/source/fix/rule detail.
- `src/components/rules/RulesView.vue`: catalog search, execution status, selection, and rule details.

`inspector-findings-mock.html` is an earlier visual exploration, not the current interaction contract. `logo/` contains the Probe V assets and usage rules.

## Information architecture

The Hub shell hosts one workspace with four real views:

| View | Primary task |
|---|---|
| Findings | Search and filter diagnostics, then inspect evidence, source, suggestions, and rule context. |
| Coverage | Identify missing evidence, unavailable checks, and verification requirements. |
| Rules | Search the rule catalog and execution status, inspect metadata, and navigate to findings. |
| Audit | Review applied, invalid, and unused suppression directives and their original findings. |

All views use the same immutable report snapshot. Search and pagination query that snapshot, not only the rendered page. Browsing does not run analysis. The explicit **Run again** action retains the previous completed snapshot until a new result is available.

Coverage is not a success score. `checked` means evaluated, not passed. Non-complete coverage keeps a persistent warning and a route to Coverage, including when a filter returns no findings. A filter-empty result, a clean report, an incomplete report, and a transport error remain distinct states.

## Layout and hierarchy

- The header separates product identity from the consuming project name. Export, rescan, language, and theme remain available at narrow widths.
- Four navigation items use one green active indicator, with contextual findings/audit counts.
- Desktop Findings uses a 240px filter column, a results list, and a slightly wider detail pane. Each region scrolls independently.
- At 1080px and below, search stays visible and **Filters** expands all existing facets. Active-filter count and **Clear filters** remain available while collapsed; no facet is silently removed.
- At 720px and below, findings and detail stack vertically. Rules stacks its list and detail at 760px and below. Narrow layouts retain source, evidence, and all detail tabs rather than presenting a reduced report.
- Rules gives search a full toolbar row, beside a labeled execution-status control. Rule identifiers and descriptions are readable without interpreting counts as a pass/fail verdict.

List rows use separators rather than nested cards. Selection uses a green edge and soft fill; severity remains an independent labeled badge. Messages may occupy two lines, while the full selected message and paths wrap in the detail pane.

## Visual system

The first visit follows the operating-system color scheme. Explicit theme and locale choices persist. Dark is the canonical design reference; light is a fully supported surface.

Use semantic `--doctor-*` colors from `tailwind.css`, not copied palette values. Vue green identifies interaction and selection. Error, warning, and information use their own muted semantic colors, always paired with text or an icon.

Body and control text is generally 13–14px, metadata 12px, and compact badges/footer 11px. Detail titles are 18–20px. System sans is used for prose and chrome; monospace for rule codes, paths, and source. Numeric counts use tabular figures.

Pane spacing is 16–28px; controls have small radii. Shadows belong to overlays, not static panes. Lucide icons are bundled individually with the UI, so icon-only controls work on the first load without an external icon service.

## Interaction and accessibility

- `/` focuses the current view's search when not typing in a field.
- Up/Down moves findings and rule selection. Rule lists also support Home/End.
- Detail tabs use Left/Right and Home/End, roving focus, and linked tab/tabpanel semantics.
- Clearing filters returns focus to the persistent search input and restores the complete result set.
- Responsive filter disclosure exposes its expanded state and controlled region; native buttons and Reka selects retain keyboard behavior.
- Focus indicators use the contrast-safe accent foreground in both themes. Result-count updates are announced politely.
- Icon-only header actions keep accessible names. Source and package paths are facts, not decorative content, and must remain readable or reveal their full text in detail.

Motion is limited to brief press/color feedback, disclosure/select chevrons, and a short initial opacity reveal. Selection and data updates are immediate; no transition gates analysis or input. The rescan spinner only indicates an active operation. Reduced motion limits animations to one near-instant iteration and keeps the same state and controls available.

## Visual acceptance

Use the actual Inspector host and a real report, not the historical mock, for visual review. Check desktop and 390px layouts in both themes, populated and empty filters, rule metadata without findings, keyboard selection, source snippets, rescan/stale state, and all four routes. Confirm that controls remain reachable, long identifiers do not create horizontal page overflow, and local UI icons cause no third-party requests.
