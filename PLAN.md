# @-Mention File Attachments — Implementation Plan

**Status:** Phases 0–2 implemented; manual vault test + Phase 3 polish remain
**Branch:** feat/at-mention (local only — not pushed; `main` untouched)
**Last updated:** 2026-06-05
**Parent idea:** ~/garden/idea/openclaw-obsidian-at-mention-files.md

---

## Overview

Add inline `@`-mention file attachment to the ObsidianClaw chat input. Typing `@` opens a fuzzy-search dropdown of vault files. Selecting one adds it as context to the message, displayed as a chip in the preview strip. Multiple files per message supported.

---

## Current State

The @-mention feature (Phase 2) is implemented on `feat/at-mention`, on top of the pre-existing multi-attachment support (Phase 1). Attachment paths:

1. **Attach button** (＋ icon in input row) → OS file picker (`<input type="file" multiple>`) → `handleFileSelect()` → `classifyFile`/`truncate`/`wrapTextContent` → push to `pendingAttachments[]`
2. **`@`-mention** → typing `@` opens the `InlineSuggest` dropdown of vault files → `chooseMention()` reads the file and pushes to `pendingAttachments[]`
3. **Paste** → `handlePastedFile()` for clipboard images
4. **`_AttachmentModal`** — `FuzzySuggestModal<TFile>`, defined but unused (kept for a possible "browse files" button)

State is an array `pendingAttachments: { name, content, vaultPath?, base64?, mimeType? }[]`, rendered as removable chips in `attachPreviewEl`; `sendMessage()` concatenates text contents and sends images as base64.

The test harness + CI gate (Phase 0) also live on this branch and reach `main` when `feat/at-mention` merges — origin `main` does not have `ci.yml` yet.

---

## Phase 0: Test Harness (do this first — TDD)

Goal: a **simple, plain, boring, reliable** test system with zero magic, so every phase below can be written test-first. No new test framework, no config files, no transpile step beyond what we already need.

### Choice: Node's built-in test runner

- **Runner:** `node:test` (built into Node ≥18) + `node:assert/strict`. No Jest, no Vitest, no extra runtime deps.
- **TypeScript:** run tests through `tsx` (one devDependency) so `.test.ts` files run directly — no separate compile/output step.
- **Why boring wins:** the runner ships with Node, the assertions are stdlib, and there's no config to drift. If `tsx` ever breaks, `tsc` + plain `node` still runs the emitted JS.

### 0.1 The obsidian-import problem

`main.ts` imports from `obsidian` at the top, and `obsidian` has no runtime — it's types only. Importing `main.ts` into a test would explode. So:

- [x] **Pure logic extracted into `obsidian`-free modules:** `lib.ts` (`str`) and `at-mention.ts` (`detectMention`, `rankMentions`, `classifyFile`, `truncate`, `wrapTextContent`) — no `obsidian` import; these are the unit-tested units.
- [x] `main.ts` stays the Obsidian-facing shell and imports them. (Exception: the `InlineSuggest` DOM class lives in `main.ts` since it needs the DOM — not unit-tested, verified manually.)
- [x] First extraction target: `str()` extracted to `lib.ts`, imported by `main.ts`. Proved the harness on existing code.

### 0.2 Wire it up — DONE

- [x] Add `tsx` to `devDependencies`
- [x] Add scripts: `"test": "node --import tsx --test \"**/*.test.ts\""` and `"test:watch": "… --watch …"` (using `node --import tsx` so Node does the glob expansion and runs its built-in test runner)
- [x] Convention: a module `foo.ts` is tested by a sibling `foo.test.ts`
- [x] `tsconfig.json` `include` already covers `.test.ts` (globs `**/*.ts`); esbuild entry stays `main.ts`, so test files never ship in `main.js` (verified: `grep` of `main.js` for test strings = 0)
- Note: use named imports for node stdlib in tests (`import { strict as assert } from "node:assert"`) — the repo's tsconfig has no `allowSyntheticDefaultImports`, so default-importing `node:assert/strict` fails typecheck.

### 0.3 Prove it — DONE

- [x] `lib.test.ts` covers `str()`, `npm test` passes (2 tests green)
- [x] Typecheck + build stay green after the extraction
- [ ] (optional) Make a test fail on purpose to confirm non-zero exit — the CI gate already relies on this

### 0.4 CI gate — DONE

- [x] `.github/workflows/ci.yml`: on every PR to `main` (and push to `main`) runs install → lint → typecheck → **test** → build, as job `build-and-test`
- [x] Branch protection on `main`: requires the `build-and-test` check to pass (strict / up-to-date with base) and a PR before merging (0 approvals required). `enforce_admins: false` leaves an owner escape hatch. **This is what actually blocks a merge when tests fail.**

### TDD workflow for the phases below

For each unit of pure logic: **write the failing test first**, then the implementation, then refactor. The per-phase "Test" subsections below are split into:

- **Unit (automated, write-first):** pure logic with `node:test` — trigger detection, query extraction, fuzzy ranking, content wrapping, truncation. These gate every commit.
- **Manual (in Obsidian):** anything touching the DOM, the dropdown overlay, keyboard focus, or real vault I/O. Verified by hand in a live vault, as today.

Don't chase 100% coverage of UI glue. Cover the logic that's easy to get subtly wrong (the `@`-trigger rules, query slicing, truncation boundaries) and leave the rendering to manual checks.

---

## Phase 1: Multiple Attachments — ALREADY IMPLEMENTED

> Discovered during Phase 2 work: the code already uses `pendingAttachments: [...]` with push-on-attach, per-chip `×` removal (`renderAttachPreview`), multi-file concat in `sendMessage`, and array-clear on send. The 1.1 checklist below is left for reference; it's done. The pure file-handling logic (`classifyFile` / `truncate` / `wrapTextContent`) was extracted to `at-mention.ts` and `handleFileSelect` now delegates to it, with unit tests.

Refactor from single to array. No UX changes — just plumbing so multiple files can be queued.

### 1.1 Change data structure — already in the codebase

- [x] `pendingAttachments: { ... }[] = []` (array, not single)
- [x] `handleFileSelect()` pushes to the array
- [x] `sendMessage()` concatenates all text attachment contents; images sent as base64
- [x] Preview strip (`renderAttachPreview`) shows all chips, each with a `×` remove button
- [x] Remove handler splices from the array
- [x] On send, the array is cleared

### 1.2 Test

**Unit (write-first):**

- [ ] Optional: extract the send-time concat into a pure `buildMessageBody(text, attachments[])` and test 0/1/2 attachments. Not done — the concat still lives inline in `sendMessage()`. Low priority; revisit if that logic gets hairier.

**Manual (in Obsidian):**

- [ ] Attach two text files via the file chooser, verify both contents appear in the sent message
- [ ] Remove one chip, verify only the remaining file is sent
- [ ] Send with no attachments — verify it works as before
- [ ] Send with an image attachment — verify vault path handling still works

---

## Phase 2: Inline @-Suggest — IMPLEMENTED (pending manual vault test)

The core feature. A custom dropdown positioned below the textarea that fuzzy-searches vault files on keystroke.

> Built across small commits on `feat/at-mention`:
> - `rankMentions` ranking comparator (`at-mention.ts`, unit-tested)
> - `InlineSuggest` dropdown class (`main.ts`): overlay, wrap-around highlight, click/hover select
> - Textarea `input` trigger → `detectMention` → open/update/close, ranked via Obsidian `prepareFuzzySearch`; blur closes
> - Keydown nav: Arrows move, Enter/Tab select, Escape closes (intercepted before send)
> - `chooseMention`: strips the `@query` (caret stays put), reads the vault file, attaches text/image/binary
> - CSS in `styles.css`, themed with Obsidian vars
>
> **Deviations from the plan (2.2):**
> - Escape only closes the dropdown; it does **not** delete the typed `@query` (felt destructive).
> - `@@` only *suppresses* the picker — the text keeps a literal `@@`; it does **not** collapse to a single `@` as the plan intended.
> - Backspace has no special handling: an empty query (`@` alone) keeps the picker **open**; it closes only once the `@` itself is deleted (`detectMention` returns null). The plan's "close on empty query" is not implemented.
>
> The **Unit (write-first)** checklist under 2.7 is done and green (25 tests). The **Manual (in Obsidian)** checklist under 2.7 still needs a real vault — I can't drive the UI from here.

### 2.1 InlineSuggest class

Create a new class (in `main.ts` or a separate file imported) that:

- [x] Renders a positioned `<div>` (above the input area) with a scrollable list of vault files
- [x] Uses Obsidian's `prepareFuzzySearch()` for ranking (the actual API in this version, not `prepareQuery`/`fuzzySearch`)
- [ ] Caches `app.vault.getFiles()` and refreshes on vault events — **not done**; currently calls `getFiles()` per keystroke. Moved to Phase 3 (perf).
- [x] Ranks results: recency-first when query is empty; score-desc then recency when querying (`rankMentions`)
- [x] Shows file path for disambiguation (basename prominent, folder muted)
- [x] Limits display to 50 results

### 2.2 Trigger logic

Hook into the textarea's `input` and `keydown` events:

- [x] On `input`: detect `@` after whitespace or at start → open suggest
- [x] Do NOT trigger mid-word (`email@domain`) — `detectMention` only fires at a word boundary
- [x] On further input: update the query (everything after `@` until cursor)
- [~] `@@`: picker is suppressed, but the text keeps a literal **`@@`** (two chars). The plan wanted `@@` to collapse to a single literal `@` — **not implemented**. `detectMention` returns null when the word starts with `@@`, so the picker just doesn't open.
- [~] Escape: closes the picker but does **not** delete the typed `@query` (deliberate deviation — deleting text on Escape felt destructive)
- [~] Backspace: closes only when the `@` itself is deleted (then `detectMention` returns null). With an **empty query** (`@` alone, cursor after it) the picker **stays open** showing all files — the plan's "close on empty query" is **not implemented**.

### 2.3 Keyboard navigation

- [x] ArrowDown / ArrowUp: move highlight (wraps around)
- [x] Enter / Tab: select the highlighted file
- [x] Escape: close picker without selecting

### 2.4 Selection behavior

When a file is selected:

- [x] Remove the `@` + query text from the textarea (`removeMentionText`)
- [x] Add the file to `pendingAttachments`
- [x] Add a chip to the preview strip (via `renderAttachPreview`)
- [x] Close the dropdown
- [x] Leave the caret where the `@` was, so the user can keep typing

### 2.5 File content handling

Shares the pure helpers with `handleFileSelect()`:

- [x] Text files: `app.vault.read(file)` → `wrapTextContent(name, truncate(content))`
- [~] Image files: read via `readBinary` + `arrayBufferToBase64` and send as base64 (deviation — plan said copy into `openclaw-attachments/` via `createBinary`; base64 reuses the existing image send path and avoids writing into the vault). No resize yet (file-picker images are resized; vault images are not).
- [x] Other binary: descriptive `[Attached file: …]` line
- [x] Truncate text files at 10K chars

### 2.6 CSS

- [x] Styled to match Obsidian's suggest overlay (popover bg, border, hover highlight) — `.openclaw-suggest*` in `styles.css`
- [~] Positioning: used **option 3** (fixed, anchored above the input area), not caret coordinates — simpler and what most chat UIs do
- [x] Dark/light theme via Obsidian CSS vars
- [x] Chips in the preview strip (pre-existing `.openclaw-attach-chip` styling)

### 2.7 Test

**Unit (write-first — these are the bug-prone bits, test them hard):** — in `at-mention.ts` / `at-mention.test.ts`

- [x] `detectMention(text, cursor)` → active `@`-query + `@` index, or null. Covers: `@` at start, after whitespace, after newline, `email@domain` (no trigger), `@@`/`@@foo` (literal escape), whitespace closing the mention, nearest-`@` selection, query sliced to cursor. (Folds in `extractQuery` — it returns the query directly.)
- [x] `classifyFile({name, mimeType})` → `image | text | binary`, by mime then extension. (Also now dedupes `handleFileSelect`.)
- [x] `wrapTextContent(name, content)` → `File: …\n\`\`\`\n…\n\`\`\`` exact string (the `\n\n` separator is added at send-time concat, not here — matches existing behavior)
- [x] `truncate(content, 10_000)` → boundary cases: at-limit untouched, one-over clipped + marker
- [x] `rankMentions` ranking comparator (recency-first with no query; score-desc then recency with a query) over fixed records, scorer injected — 5 deterministic tests.

> Note: `rankMentions` takes plain `{path, mtime}` records plus an **injected `score(query, path)` function**, not `TFile`, so it stays `obsidian`-free and testable. `main.ts` (`mentionItems`) backs that function with Obsidian's `prepareFuzzySearch(query)` and maps real `TFile`s onto the records.

**Manual (in Obsidian):**

- [ ] Type `@` — dropdown appears with vault files
- [ ] Type `@proj` — dropdown filters to files matching "proj"
- [ ] Arrow keys navigate, Enter selects
- [ ] Escape closes without attaching (text is left as typed)
- [ ] `@@` — picker does NOT open; text shows literal `@@` (does not collapse to one `@`)
- [ ] Select a `.md` file — content included in message
- [ ] Select an image — attached as base64 (no vault copy)
- [ ] Multiple `@` mentions in one message — all attached
- [ ] Remove a chip via `×` — removed from attachments
- [ ] Backspace deleting the `@` — picker closes (note: `@` with empty query keeps it open)

---

## Phase 3: Polish

- [ ] Debounce search input (150ms) for large vaults (10k+ files)
- [ ] Animate dropdown open/close (subtle, <200ms)
- [ ] Show file type icon in dropdown (📝 for md, 🖼 for image, etc.)
- [ ] Mobile: handle virtual keyboard, touch selection
- [ ] Edge case: vault with 10k+ files — benchmark filter performance
- [ ] Edge case: file with no extension
- [ ] Edge case: `@` at end of message after punctuation
- [ ] Consider: wire up the unused `AttachmentModal` as a "browse files" button alternative (low priority)

---

## Implementation Notes

### Where to add code

- **Pure logic → `obsidian`-free modules** (e.g. `at-mention.ts`): trigger detection, query extraction, ranking comparator, content wrapping, truncation. These are the unit-tested units. This is a deliberate break from the single-file convention, and it's the whole reason testing is tractable — keep these files free of any `obsidian` import.
- `InlineSuggest` class (the DOM/overlay piece): add in `main.ts` or a `suggest.ts` that imports `obsidian`. Not unit-tested; verified manually.
- All changes to `OpenClawChatView`: inline in the existing class methods, delegating logic to the pure modules
- CSS: add to `styles.css`

### Key Obsidian APIs

- `app.vault.getFiles()` — returns `TFile[]` for all files in vault
- `app.vault.getAbstractFileByPath(path)` — resolve a `TFile` from a path (instanceof-check the result)
- `app.vault.read(file: TFile)` — read file content (text)
- `app.vault.readBinary(file: TFile)` — read binary content
- `arrayBufferToBase64(buf)` — from `obsidian`; used to base64-encode vault images
- `prepareFuzzySearch(query: string)` — from `obsidian`; returns `(text) => SearchResult | null` where `SearchResult.score` ranks the match. (This version has no `prepareQuery`/`fuzzySearch` exports.)
- `app.vault.on('create' | 'modify' | 'rename' | 'delete', callback)` — vault file events (for the Phase 3 file-list cache)

### Caret position

Textarea doesn't expose caret pixel coordinates natively. Options:

1. **Canvas measurement trick** — create an offscreen canvas, measure text width up to `selectionStart`, add to textarea's left padding. Works but fiddly with line wrapping.
2. **Mirror div** — create a hidden div with matching font metrics, measure position. More accurate but heavier.
3. **Fixed position below textarea** — skip per-caret positioning, always show dropdown anchored to the bottom-left of the input area. Simpler, less brittle, and what most chat UIs actually do (Slack, Discord, etc.).

**Recommendation:** Start with option 3. If it feels wrong, upgrade to option 1 later.

**Decision:** Shipped option 3 (dropdown anchored above the input area). Revisit only if per-caret positioning is requested.

### Existing AttachmentModal

`_AttachmentModal` (a `FuzzySuggestModal<TFile>`) is defined but not wired up. It could become a "browse all files" button or stay unused. Don't remove it — it's harmless and could be useful later.

---

## @-Mention Context Quality — Improvement Tasks

These come from testing the feature as a user (attaching the idea doc as @-mention context) and critiquing what the agent receives.

### Truncation handling

- [ ] **Raise or make the truncation limit configurable.** The idea doc (~200 lines) got cut off at "Handle `@@`..." with a `(truncated)` marker. For a spec/plan file this is a real data loss — the implementation phases and edge-case table were lost. Options: increase the default, add a setting, or at minimum ensure truncation cuts at a section boundary rather than mid-sentence.
- [ ] **Move highest-signal content toward the top of attached files.** The edge-case table and MVP scope sections are the most actionable for implementation; they should appear early enough to survive truncation. Consider reordering plan files so critical sections come first, or splitting very long files into a summary + full-content attachment.
- [ ] **For long files, attach a summary block (first ~50 lines) plus a "full content also attached" note** so key context always survives truncation. This is a content-formatting task for the files we write, but the plugin could also offer a `@summary` variant that only sends the first N lines.

### Metadata and path clarity

- [ ] **Include full vault-relative path, not just filename.** The current attachment format uses `File: filename.md` — if two files share a name in different directories (e.g. `PLAN.md` in two folders), the agent can't tell them apart. Change to `File: idea/openclaw-obsidian-at-mention-files.md` (vault-relative path).
- [ ] **Add file size or line count to the attachment header.** Helps the agent gauge whether it's seeing the whole file or a truncated excerpt. E.g. `File: idea/openclaw-obsidian-at-mention-files.md (215 lines)` vs `File: PLAN.md (truncated at 10K chars)`.

### Rendering and readability

- [ ] **Evaluate whether raw markdown-in-fenced-block is the best format.** Currently the file content arrives inside triple-backtick markdown blocks, meaning the agent sees raw `##`, `**`, and table pipes rather than rendered structure. This works but adds noise. Consider: (a) sending content without fencing if it's already markdown, or (b) at minimum, confirming that the receiving agent parses the fencing correctly and doesn't double-escape.
- [ ] **Separate design decisions from implementation detail.** The chip-rendering options (A/B/C) are a design choice, not implementation — they could live in a `decisions.md` or a separate @-mentionable file, keeping the plan doc tighter for the truncation budget.

### Sender intent signal

- [ ] **Consider a brief intent prefix when attaching files.** When a file arrives as `@filename.md` with no context, the agent must infer why it was attached. The plugin can't read the user's mind, but it could encourage intent by: (a) inserting the filename at the cursor position (so the user naturally types around it, e.g. "review this spec @PLAN.md"), or (b) adding a small prompt hint in the UI like "Add context about what you want...". This is a UX touch, not a format change, but it directly improves the quality of agent responses.