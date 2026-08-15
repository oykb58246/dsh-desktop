# Agent Note: Narrow-viewport sidebar re-expand becomes an overlay drawer

Status: implemented

English | [中文](2026-08-15-narrow-sidebar-overlay-drawer.zh.md)

## Problem

Below the `SIDEBAR_AUTO_COLLAPSE` breakpoint the sidebar auto-collapses to the 56px rail, and a manual toggle re-expands it through the `narrowExpanded` override. The re-expansion fed the width preference back into the same three-column concession chain, so on a phone the expanded 280px sidebar and the center shared the viewport in-flow: at 390px the center conceded to 110px — unusable, and exactly what mobile users reported as "squeezed" UI. The chain comment promised "over the squeezed center" but the solver has no overlay concept; the center absorbed the deficit as the final fallback.

## Decision

A narrow manual re-expand now renders as an **overlay drawer**:

- The grid keeps a **zero sidebar track** (`0px minmax(0, 1fr) 0px`), so the center never concedes — full viewport width at any narrow size.
- The sidebar column is lifted out of flow (`position: absolute`, `z-index: 30`, left-anchored, shadowed) and rendered expanded at the drawer width: the sidebar preference, or the contract default when the wide preference is closed, **clamped to `viewport - 24`** so at least 24px of content stays visible beside the drawer.
- A click-to-close **backdrop** (`z-index: 25`) sits under the drawer; clicking it invokes the same `toggleSidebar` that opened it, so the store semantics (preference untouched, `narrowExpanded` flipped) are unchanged.
- No resize handle while the drawer is open; `data-sidebar-overlay` marks the frame for CSS.

Wide viewports are untouched: `overlaySidebar` is `narrow && narrowExpanded`, and everything above the breakpoint behaves exactly as before. The `narrowExpanded` override is still dropped when crossing the breakpoint (stores.ts `setNarrow`), so returning to wide restores the pre-squeeze layout.

## Alternatives considered

- **In-flow re-expansion (status quo).** Rejected: it is the reported squeeze; the center column has no usable width at phone sizes.
- **Drawer at full preference width, unclamped.** Rejected: a wide-drag preference (up to 420px) can exceed the phone viewport; clamping to `viewport - 24` keeps the drawer fully on-screen.
- **Auto-close the drawer on selection.** Deferred: session/workspace selection currently leaves the drawer open; closing it on selection is a follow-up interaction decision, not a layout-correctness fix.

## Consequences

- Phone/tablet (below 1024px) users get a full-width center at all times; the sidebar is either the 56px rail or an overlay drawer with a scrim.
- The drawer width is derived (`drawerWidth`), never written back to the store: the width preference survives narrow sessions unchanged.
- `data-sidebar-overlay` and the backdrop are new frame contract: any future narrow-specific overlay stacking must respect the sidebar `z-index: 30` / backdrop `z-index: 25` / shell overlay `z-index: 20` order.
- Coverage: app-frame specs assert the zero track, full center, drawer owner props, backdrop presence and click-to-close, and the phone clamp (new specs); desktop behavior specs are unchanged and green.
