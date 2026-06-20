# Plan: Move OcO Chat from Sidebar to Tab

## Executive Summary

Open the OcO chat interface as a **regular document tab** created on demand. One command, multiple tabs allowed, no startup hijacking. The view is placement-agnostic—it will work in a sidebar or popped-out window if the user drags it there—but the primary activation path is a new tab.

Simplicity is the feature. Sidebar-specific mobile hacks and narrow-layout switches are retired. The internal model shifts from a singleton chat view to a registry of independent leaves.

---

## Command

| ID | Name | Behavior |
|---|---|---|
| `open-chat-tab` | **Open chat in new tab** | Opens a new chat tab. Re-invoking spawns another. |

Other commands (`ask-about-note`, `reconnect`) stay but do not implicitly create a tab unless needed.

---

## Architecture

- **Multi-leaf, no singleton.** Each tab is an independent `WorkspaceLeaf`. The plugin tracks a `Set<OpenClawChatView>` plus an `activeChatView` pointer for convenience (last-focused or last-created).
- **Event broadcast.** `GatewayClient` notifies all registered views. Each view handles only events matching its own `sessionKey`.
- **Lazy activation.** No startup auto-open. Respect workspace restoration.
- **Placement-agnostic view.** `registerView` stays the same. The view works in a tab, a sidebar, or a popped-out window. This plan targets tab creation for the command.

---

## Files

### `src/main.ts`

1. **Registry**
   - Replace `chatView: OpenClawChatView | null` with:
     ```ts
     private chatViews = new Set<OpenClawChatView>()
     activeChatView: OpenClawChatView | null = null
     ```
   - Add `registerChatView(view)`, `unregisterChatView(view)`, `broadcastToChatViews(fn)`.

2. **`openChatInNewTab()`**
   - Use `this.app.workspace.getLeaf('tab')`.
   - Set view state to `{ type: VIEW_TYPE, active: true }`.
   - Focus the leaf.
   - No deduplication — always creates.

3. **`askAboutNote()`**
   - If `activeChatView` exists, focus it and pre-fill input.
   - Otherwise call `openChatInNewTab()` then pre-fill.

4. **Commands**
   - Register `open-chat-tab` with name **"Open chat in new tab"**.
   - Keep `ask-about-note` and `reconnect`.

5. **Gateway routing**
   - Replace all `this.chatView?.…` with `broadcastToChatViews(v => v.…)`.
   - Stream events route by matching `sessionKey` inside each view.

6. **Startup**
   - Remove `onLayoutReady` auto-open.
   - First-run welcome modal stays.

### `src/chat-view.ts`

1. **Lifecycle**
   - `onOpen`: register with plugin.
   - `onClose`: unregister from plugin.

2. **Delete sidebar-specific code**
   - Capacitor Keyboard drawer-hiding block (~90 lines).
   - `workspace-drawer-inner`, `workspace-drawer-tab-container` queries.
   - Hamburger bar / `oc-hamburger-bar` and its dropdown.
   - `ResizeObserver` for narrow-layout switching.
   - `updateTabMode()`.
   - `initTouchGestures()` if it only served the drawer.

3. **Stream handling**
   - Ensure `handleStreamEvent` and `handleChatEvent` gate on matching `sessionKey` so unrelated views ignore foreign streams.

### `styles.css`

- Remove unused `.oc-hamburger-*` rules.
- Verify no `.workspace-drawer-*` overrides remain.
- Drop `max-width` constraints tuned for narrow sidebars so the tab fills editor width.

---

## Features Intentionally Lost

| Feature | Reason |
|---|---|
| Startup auto-open | Tab is opt-in via command. |
| Mobile drawer keyboard hacks | Tabs use standard Obsidian mobile handling. |
| Hamburger tab switcher | Full editor width makes it unnecessary. |
| Singleton `chatView` pointer | Registry supports concurrent tabs. |

---

## Acceptance Criteria

1. `npm run build` passes.
2. One chat command in palette: **"Open chat in new tab"**.
3. Command opens `OpenClawChatView` in a new tab leaf (`getLeaf('tab')`).
4. Re-invoking the command opens additional tabs.
5. Ribbon icon opens a new tab (same behavior as command).
6. `Ask about current note` focuses the active chat tab if one exists, else opens a new tab and pre-fills input.
7. Gateway events update all open chat tabs; each tab only renders streams matching its `sessionKey`.
8. No `.workspace-drawer-*` or Capacitor resize-mode code remains in source.
9. Chat tab layout works at full editor width without horizontal clipping.
10. Mobile: chat in a tab is usable without custom keyboard hacks.
