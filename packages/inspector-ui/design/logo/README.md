# Vue Doctor Logo — Probe V

Brand mark for Vue Doctor: product icon, favicon, Inspector header, CLI/README badge.

## Concept

**Name:** Probe V

**Metaphor:** diagnose / inspect a Vue project with precision.

| Element | Meaning |
|---|---|
| Open geometric **V** | Vue-family signal without copying the official filled layered triangle |
| Horizontal **scan line** | Diagnostic pass / contract inspection |
| Center **probe node** | Focus of analysis — the finding under the lens |

Not used (on purpose): stethoscope, medical cross, clipboard, cartoon doctor, glassmorphism shield, pure checkmark badge.

Personality: precise developer tool, quiet confidence, Vue-adjacent green.

## Files

| File | Use |
|---|---|
| `mark.svg` | Primary color mark (transparent, `#42b883`) |
| `mark-mono.svg` | `currentColor` for UI chrome (header, buttons) |
| `mark-solid.svg` | Heavier mono strokes for reverse / small solid contexts |
| `favicon.svg` | 16–32 px: V + probe only (scan line dropped) |
| `app-icon.svg` | 128 dark rounded tile (Inspector / PWA-style) |
| `app-icon-light.svg` | 128 light rounded tile |
| `badge.svg` | Solid green tile + white mark (README shield, avatar) |
| `wordmark.svg` | Mark + “Vue Doctor” for light backgrounds |
| `wordmark-dark.svg` | Mark + wordmark for dark backgrounds |

## Color

| Context | Mark stroke/fill | Notes |
|---|---|---|
| Light UI / docs | `#42b883` (official Vue green) | Default product green |
| Dark UI (Inspector) | `#42d392` (Inspector accent) | Matches workbench tokens |
| On green badge | `#ffffff` | Reverse only on `#42b883` / `#42d392` |
| Mono UI | `currentColor` | Inherit text / accent token |

Light theme accent text for adjacent labels may use `#157347` for WCAG; the mark itself stays `#42b883` (decorative).

## Size rules

| Size | Form | Notes |
|---|---|---|
| **16 px** | `favicon.svg` geometry | Drop scan line; keep V + probe |
| **20–24 px** | `mark-mono` in Inspector header | Full Probe V |
| **32 px** | `mark.svg` / `badge.svg` | Canonical mark |
| **64–128 px** | `app-icon*.svg` | Rounded tile + full mark |
| **Wordmark** | ≥ 120 px wide | Under ~100 px use mark alone |

**External clear space** when placed in UI/docs: ≥ 1/8 of mark box height on all sides. Prefer more side breathing room next to dense text.

## Padding (important)

The mark path is **inset more on left/right** so it never feels edge-to-edge when cropped or placed in a rounded control.

| Axis | Inset in 32 viewBox | Why |
|---|---|---|
| Left / right | **~7.5 units** to V arm tips (before stroke) | Horizontal padding was too tight; arms no longer kiss the crop |
| Top / bottom | **~7–8 units** | Keeps optical balance with side inset |
| Stroke allowance | round caps stay inside the box | No clip at 16–32 px |

## Construction (32 viewBox)

```
V path:      M 9.5 9.5 L 16 23.5 L 22.5 9.5
Scan:        M 12 15 H 20
Probe:       circle cx=16 cy=15 r=1.85
Stroke V:    2.5, round caps/joins
Stroke scan: 1.6, round cap
Side inset:  ≥ 7.5 units from left/right edge to path
```

Favicon: V + probe only (no scan), stroke ~2.75, probe r≈2.15, same side inset philosophy.

Badge / app-icon: same relative geometry, scaled inside a rounded tile with additional outer tile margin.

## Don’ts

- Don’t recolor to non-Vue brand hues (purple SaaS gradient, red “error logo”).
- Don’t fill the V into the official Vue logo triangle or dual-tone chevron stack.
- Don’t add drop shadows or 3D bevel to the mark.
- Don’t outline the probe in a second color at ≤ 24 px.
- Don’t stretch the square mark; wordmark is ~5.7:1.
- Don’t reduce left/right padding back to edge-flush geometry.

## Inspector header usage

Replace the current bordered letter `V` with:

```html
<!-- inline mark-mono, color: var(--accent-fg) -->
<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">…</svg>
```

Pair with “Vue Doctor” (semibold 13–14 px) or project name; status lives to the right, not inside the mark.

## Export checklist (implementation)

1. Inline `mark-mono` in Inspector for theme coloring without an extra request.
2. Serve `favicon.svg` from Inspector host (`/vue-doctor/favicon.svg`).
3. Optional PNG raster set for GitHub/social: 32, 64, 128, 512 from `app-icon.svg` / `badge.svg`.
4. README badge: `badge.svg` at 20–24 px inline when needed.
