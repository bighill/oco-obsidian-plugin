# @-Mention File Attachments — Implementation Plan

**Status:** Planning
**Branch:** feat/at-mention
**Parent idea:** ~/garden/idea/openclaw-obsidian-at-mention-files.md

---

## Overview

Add inline `@`-mention file attachment to the ObsidianClaw chat input. Typing `@` opens a fuzzy-search dropdown of vault files. Selecting one adds it as context to the message, displayed as a chip in the preview strip. Multiple files per message supported.

---

## Current State

The plugin has two attachment paths, both single-file only:

1. **Attach button** (paperclip icon in input row) → opens OS file picker via `<input type="file">` → `handleFileSelect()` processes the file
2. **`AttachmentModal`** (line 1219) — `FuzzySuggestModal<TFile>` that searches vault files, but not wired to any button or command

Both set `pendingAttachment: { name, content, vaultPath? } | null` (single attachment) and show a preview strip with `attachPreviewEl`.

---

## Phase 0: Test Harness (do this first — TDD)

Goal: a **simple, plain, boring, reliable** test system with zero magic, so every phase below can be written test-first. No new test framework, no config files, no transpile step beyond what we already need.

### Choice: Node's built-in test runner

- **Runner:** `node:test` (built into Node ≥18) + `node:assert/strict`. No Jest, no Vitest, no extra runtime deps.
- **TypeScript:** run tests through `tsx` (one devDependency) so `.test.ts` files run directly — no separate compile/output step.
- **Why boring wins:** the runner ships with Node, the assertions are stdlib, and there's no config to drift. If `tsx` ever breaks, `tsc` + plain `node` still runs the emitted JS.

### 0.1 The obsidian-import problem

`main.ts` imports from `obsidian` at the top, and `obsidian` has no runtime — it's types only. Importing `main.ts` into a test would explode. So:

- [ ] **Extract pure logic into `obsidian`-free modules.** Functions that do string/data work (no `App`, no `TFile`, no DOM) move into small files that import nothing from `obsidian`. These are what we unit-test.
- [ ] Keep `main.ts` as the thin Obsidian-facing shell that imports those modules and wires them to the UI.
- [x] First extraction target: `str()` extracted to `lib.ts`, imported by `main.ts`. Proves the harness on existing code. (Attachment content/truncation helpers come during Phase 1/2.)

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

### 1.1 Change data structure

- [ ] Replace `pendingAttachment: { ... } | null` with `pendingAttachments: { ... }[] = []`
- [ ] Update `handleFileSelect()` to push to array instead of replacing
- [ ] Update `sendMessage()` to concatenate all attachment contents (not just one)
- [ ] Update preview strip rendering to show all chips, each with `×` remove button
- [ ] Update remove handler to splice from array instead of nulling
- [ ] On send, clear the array instead of nulling

### 1.2 Test

**Unit (write-first):**

- [ ] Extract the "concatenate attachment contents into the outgoing message" logic into a pure function `buildMessageBody(text, attachments[])` — test: 0, 1, and 2 attachments produce the right concatenation
- [ ] Test that clearing the array after build leaves it empty

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
> **Deviation from the plan:** Escape only closes the dropdown; it does **not** delete the typed `@query` (2.2) — that felt destructive. `@@`-as-literal is handled at detection time (no picker) rather than via an insert step. The Backspace-at-empty-`@` auto-close (2.2) isn't special-cased: deleting the `@` simply makes `detectMention` return null, which closes it.
>
> The **Unit (write-first)** checklist under 2.7 is done and green (25 tests). The **Manual (in Obsidian)** checklist under 2.7 still needs a real vault — I can't drive the UI from here.

### 2.1 InlineSuggest class

Create a new class (in `main.ts` or a separate file imported) that:

- [ ] Renders a positioned `<div>` below the textarea with a scrollable list of vault files
- [ ] Uses Obsidian's `prepareQuery()` + `fuzzySearch()` for ranking and highlighting
- [ ] Caches `app.vault.getFiles()` and refreshes on vault events (`create`, `rename`, `delete`)
- [ ] Ranks results: recently-modified first (via `file.stat.mtime`), then by fuzzy score
- [ ] Shows file path (not just basename) for disambiguation — `folder/note.md` not just `note.md`
- [ ] Limits display to ~50 results max for performance

### 2.2 Trigger logic

Hook into the textarea's `input` and `keydown` events:

- [ ] On `input`: detect `@` typed after whitespace or at start of line → open suggest
- [ ] Do NOT trigger `@` when it's mid-word (e.g. `email@domain`) — only after whitespace/start
- [ ] On further input after trigger: update the search query (everything after `@` until cursor)
- [ ] On `@@`: insert literal `@`, skip picker
- [ ] On Escape: close picker, remove the `@` + query text from textarea
- [ ] On Backspace: if query is empty, close picker and remove the `@`

### 2.3 Keyboard navigation

- [ ] ArrowDown / ArrowUp: move highlight in the dropdown
- [ ] Enter: select the highlighted file
- [ ] Escape: close picker without selecting

### 2.4 Selection behavior

When a file is selected:

- [ ] Remove the `@` + query text from the textarea
- [ ] Add the file to `pendingAttachments` array
- [ ] Add a chip to the preview strip (file name, `×` to remove)
- [ ] Close the dropdown
- [ ] Don't move cursor — leave it where the `@` was, so user can keep typing the message

### 2.5 File content handling

Reuse the existing logic from `handleFileSelect()`:

- [ ] Text files (`.md`, `.txt`, `.json`, etc.): read with `app.vault.read(file)`, wrap in `\n\nFile: filename.md\n\`\`\`\n{content}\n\`\`\``
- [ ] Image files: save to `openclaw-attachments/` via `app.vault.createBinary()`, reference absolute path
- [ ] Other binary: descriptive attachment line
- [ ] Truncate text files at 10K chars (same limit as current)

### 2.6 CSS

- [ ] Style the dropdown to match Obsidian's native suggest overlay (`.suggestion` classes)
- [ ] Position below textarea using caret coordinates (a lightweight caret-position helper or character-width estimation)
- [ ] Dark/light theme support (the plugin already follows Obsidian theme)
- [ ] Chips in the preview strip: horizontal scroll, subtle background, `×` close button

### 2.7 Test

**Unit (write-first — these are the bug-prone bits, test them hard):** — in `at-mention.ts` / `at-mention.test.ts`

- [x] `detectMention(text, cursor)` → active `@`-query + `@` index, or null. Covers: `@` at start, after whitespace, after newline, `email@domain` (no trigger), `@@`/`@@foo` (literal escape), whitespace closing the mention, nearest-`@` selection, query sliced to cursor. (Folds in `extractQuery` — it returns the query directly.)
- [x] `classifyFile({name, mimeType})` → `image | text | binary`, by mime then extension. (Also now dedupes `handleFileSelect`.)
- [x] `wrapTextContent(name, content)` → `File: …\n\`\`\`\n…\n\`\`\`` exact string (the `\n\n` separator is added at send-time concat, not here — matches existing behavior)
- [x] `truncate(content, 10_000)` → boundary cases: at-limit untouched, one-over clipped + marker
- [x] `rankMentions` ranking comparator (recency-first with no query; score-desc then recency with a query) over fixed records, scorer injected — 5 deterministic tests.

> Note: the ranking/fuzzy helpers will take plain `{path, mtime, score}` records, not `TFile`, so they stay `obsidian`-free and testable. `main.ts` runs Obsidian's `fuzzySearch` to compute `score`, then maps real `TFile`s onto them.

**Manual (in Obsidian):**

- [ ] Type `@` — dropdown appears with vault files
- [ ] Type `@proj` — dropdown filters to files matching "proj"
- [ ] Arrow keys navigate, Enter selects
- [ ] Escape closes without attaching
- [ ] `@@` inserts literal `@`
- [ ] Select a `.md` file — content included in message
- [ ] Select an image — saved to vault, referenced
- [ ] Multiple `@` mentions in one message — all attached
- [ ] Remove a chip via `×` — removed from attachments
- [ ] Backspace at `@` with no query — closes picker and removes `@`

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
- `app.vault.read(file: TFile)` — read file content (text)
- `app.vault.readBinary(file: TFile)` — read binary content
- `app.vault.createBinary(path, data)` — create binary file
- `prepareQuery(query: string)` — from `obsidian` module, creates a query object for fuzzy search
- `fuzzySearch(query, text)` — from `obsidian` module, returns `FuzzySearchResult | null`
- `app.vault.on('create' | 'modify' | 'rename' | 'delete', callback)` — vault file events

### Caret position

Textarea doesn't expose caret pixel coordinates natively. Options:

1. **Canvas measurement trick** — create an offscreen canvas, measure text width up to `selectionStart`, add to textarea's left padding. Works but fiddly with line wrapping.
2. **Mirror div** — create a hidden div with matching font metrics, measure position. More accurate but heavier.
3. **Fixed position below textarea** — skip per-caret positioning, always show dropdown anchored to the bottom-left of the input area. Simpler, less brittle, and what most chat UIs actually do (Slack, Discord, etc.).

**Recommendation:** Start with option 3. If it feels wrong, upgrade to option 1 later.

### Existing AttachmentModal

The `AttachmentModal` at line 1219 is defined but not wired up. It could become a "browse all files" button or stay unused. Don't remove it — it's not hurting anything and could be useful later.