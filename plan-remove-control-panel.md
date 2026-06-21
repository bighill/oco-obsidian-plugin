# Plan: Remove the Control Panel Drawer

## Problem Statement

The control panel (opened via the gear/dash button in the top bar) is a large sidebar-style overlay that duplicates functionality already available inline in the chat view. It adds ~120 lines of TypeScript DOM construction, five methods, and ~40 CSS rules for very little unique value.

## What the Control Panel Currently Does vs. What's Already Inline

| Control Panel Row | Inline Equivalent | Unique? |
|---|---|---|
| Agent card (emoji, name, status) | Status dot + typing indicator | No |
| Multi-agent pill switcher | Hidden top-bar agent button + dropdown | Partially¹ |
| "AI MODEL DEFAULTS" → model picker | `brainBtnEl` in input meta row | No |
| "RELIABILITY DEFAULTS" → cycle think/steps | `thinkChipEl` / `verboseChipEl` in input meta | No |
| "SERVER" (gateway URL display) | Settings tab | No |
| Footer version string | Nowhere needed | No |

¹ Agent switching is the only unique feature. It will be restored by revealing the already-existing top-bar agent button (currently hidden with `oc-hidden`).

## Files

### `src/chat-view.ts`

1. **Remove control panel button from `onOpen`**
   - Delete the `oc-control-panel-btn` element and its `click` listener.
   - Delete `SVG_CONTROL_PANEL` from imports (verify no other usage).

2. **Remove control panel DOM scaffolding from `onOpen`**
   - Delete `this.controlPanelBackdropEl` creation.
   - Delete `this.controlPanelEl` creation.
   - Delete the backdrop click listener.

3. **Reveal the agent switcher button**
   - In `onOpen`, remove `.addClass('oc-hidden')` from `this.profileBtnEl`.
   - In `updateAgentButton()`, remove `.addClass('oc-hidden')`.
   - Add a click listener on `this.profileBtnEl` to call `this.toggleAgentSwitcher()`.

4. **Remove control panel methods**
   - `toggleControlPanel()`
   - `openControlPanel()`
   - `closeControlPanel()`
   - `renderControlPanel()`

5. **Remove class fields**
   - `controlPanelEl!: HTMLElement`
   - `controlPanelBackdropEl!: HTMLElement`

6. **Preserve shared utilities**
   - `openModelPicker()` (still called by `brainBtnEl`)
   - `cycleBarControl()` (still called by chips)
   - `switchAgent()` (still called by agent dropdown)

### `styles.css`

1. **Remove control panel stylesheet block**
   - `.oc-control-panel-backdrop`
   - `.oc-control-panel`
   - `.oc-control-panel-header` and child rules
   - `.oc-control-panel-title` / small / `.oc-panel-ok` / `.oc-panel-warn`
   - `.oc-control-panel-close`
   - `.oc-control-card` and children (`.oc-control-card-label`, `.oc-control-card-value`, `.oc-control-url`)
   - `.oc-control-actions`, `.oc-control-wide-btn`, hover states
   - `.oc-hud-agent-card` and all `.oc-hud-*` children:
     - `.oc-hud-identity`, `.oc-hud-orb`, `.oc-hud-orb-emoji`, `.oc-hud-identity-info`
     - `.oc-hud-agent-name`, `.oc-hud-status-line`, `.oc-hud-group-label`
     - `.oc-hud-section`, `.oc-hud-section-toggle`, `.oc-hud-section-label`
     - `.oc-hud-section-value`, `.oc-hud-section-chevron`, `.oc-hud-footer`
   - `.oc-agent-row`, `.oc-agent-pill`, `.oc-agent-pill-emoji`, `.oc-agent-pill-name`

2. **Keep agent button/dropdown styles**
   - `.openclaw-agent-btn` and `.openclaw-agent-dropdown` stay.

### `src/svgs.ts`

1. **Remove `SVG_CONTROL_PANEL`** if no longer referenced anywhere.

## Acceptance Criteria

1. `npm run build` passes.
2. `npm run lint` passes.
3. `npm test` passes.
4. The gear/dash button is gone from the top bar.
5. The agent emoji button is visible in the top bar (right side) when agents are loaded.
6. Clicking the agent button opens the dropdown and switching agents works.
7. Model picker, think chip, and verbose chip in the input row still function.
8. No `.oc-control-panel*`, `.oc-hud-*`, or `.oc-control-card*` CSS selectors remain.

## Progress

- [x] **Commit 1**: Removed control panel class fields, control panel button & DOM scaffolding from `onOpen`; revealed agent switcher button (removed `oc-hidden`, added click listener, fixed CSS `display: none` → `flex`, made `updateAgentButton()` render emoji). Build passes.
- [x] **Commit 2**: Removed control panel methods (`toggleControlPanel`, `openControlPanel`, `closeControlPanel`, `renderControlPanel`) and unused `SVG_CONTROL_PANEL` import from `chat-view.ts`. Build & lint pass.
- [x] **Commit 3**: Removed `SVG_CONTROL_PANEL` definition from `svgs.ts`. Build, lint, test pass.
- [x] **Commit 4**: Removed all control panel CSS selectors from `styles.css` (~160 lines). Build, lint, test pass. All acceptance criteria met.
