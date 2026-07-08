# Plan: Show Current Agent Name as a Text Label

## Goal
Replace (or supplement) the robot emoji agent-switcher button with a visible text label showing the currently selected OpenClaw agent name.

## Background
- The agent switcher is rendered in `OpenClawChatView.updateAgentButton()` (`src/chat-view.ts`).
- Today it only displays the agent emoji (`this.activeAgent.emoji`), defaulting to `🤖`.
- The agent `name` is never injected into the DOM, so CSS-only or snippet-based solutions cannot display it dynamically.

## Why CSS-only is not enough
The current DOM structure is:

```html
<div class="openclaw-agent-btn" aria-label="Switch agent">
  <span class="openclaw-agent-emoji">🤖</span>
</div>
```

There is no `data-agent-name`, `title`, or text node containing `activeAgent.name`. A CSS `::after { content: "..." }` rule can only show static text, not the actual selected agent name.

## Minimal code change required

### Status

- [x] Read plan and inspect current code
- [x] Inject the agent name into the button DOM
- [x] Style the label in `styles.css`
- [x] Build, lint, test, format check
- [x] Commit

### 1. Inject the agent name into the button DOM
In `src/chat-view.ts`, inside `updateAgentButton()`:

```ts
private updateAgentButton(): void {
  if (!this.profileBtnEl) return
  this.profileBtnEl.empty()
  this.profileBtnEl.createSpan({
    text: this.activeAgent.emoji || '🤖',
    cls: 'openclaw-agent-emoji',
  })
  // NEW: always render the agent name next to the emoji
  this.profileBtnEl.createSpan({
    text: this.activeAgent.name || 'Agent',
    cls: 'openclaw-agent-name',
  })

  if (this.agents.length <= 1) {
    this.profileBtnEl.addClass('oc-hidden')
    this.profileDropdownEl?.addClass('oc-hidden')
  } else {
    this.profileBtnEl.removeClass('oc-hidden')
  }
}
```

### 2. Style the label in `styles.css`
Add rules so the name is readable, truncates gracefully, and keeps the existing layout:

```css
.openclaw-agent-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
}

.openclaw-agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85em;
}
```

### 3. Optional variations
- **Emoji only, name on hover:** add the name to the `aria-label` / `title` attribute instead of visible text.
- **Name only, no emoji:** remove the emoji span entirely from `updateAgentButton()`.
- **Name outside the button:** create a separate label element in `onOpen()` and update it in `updateAgentButton()`.

## Files to touch
- `src/chat-view.ts` — add name rendering in `updateAgentButton()`.
- `styles.css` — add layout/truncation styles for `.openclaw-agent-name`.

## Bug: Agent switcher changes label but not history

### Status

- [x] Reproduce / inspect the switch flow
- [x] Identify why history stays the same
- [x] Apply minimal fix
- [x] Build, lint, test, format check
- [x] Commit

### Current behavior

When the user picks a different agent from the dropdown:
1. The button label updates to the new agent name.
2. The chat history area flashes but still shows the previous agent's messages.
3. Sending a new message may still land in the old agent's session.

### Likely cause

`loadHistory()` and `sendMessage()` pass the raw local `sessionKey` (e.g. `"main"`) to `chat.history` / `chat.send`. The gateway stores sessions under full keys like `agent:<agentId>:<sessionKey>` (as seen in `sessions.list`). Without the agent prefix, the gateway likely resolves the unprefixed key to a default agent (`agent:main:...`), so every agent selection loads the same history.

This is inconsistent with `sessions.patch` and `deleteSessionWithFallback`, which already use `${this.agentPrefix}${sessionKey}`.

### Fix

Use the fully-prefixed session key for all `chat.*` gateway requests:
- `chat.history` in `loadHistory()`
- `chat.send` in `sendMessage()`
- `chat.send` for `/reset` in `resetTabAction()`
- `chat.send` for `/new` in `createNewTabAction()`
- `chat.send` for `/model` in `model-picker-modal.ts`
- `chat.abort` in `abortMessage()`

Also clear `this.messages` / `this.messagesEl` in `switchAgent()` before `loadHistory()` so the UI doesn't briefly retain stale messages.

### Out of scope

- Refactoring the session-key helper (keep `sessionKey` as suffix, prefix at call sites).
- Changing how agents are listed or the dropdown UI.

## Out of scope
This plan intentionally does **not** change:
- How the agent dropdown works.
- Session routing or `agentPrefix` logic.
- Multiple gateway connections.

## Verification
After building (`npm run build`), the DOM should look like:

```html
<div class="openclaw-agent-btn" aria-label="Switch agent">
  <span class="openclaw-agent-emoji">🤖</span>
  <span class="openclaw-agent-name">research-bot</span>
</div>
```

Switching agents should update the `.openclaw-agent-name` text without a page reload.
