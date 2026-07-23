// Saved-prompt loader: scans `prompts/*.md` in the vault root, parses YAML
// frontmatter (description, argument-hint), and returns the prompt body with
// `$@` substitution support. No caching — read from disk every time the
// dropdown opens, per the design in idea/oco-saved-prompts.md.

import { TFile, type Vault } from 'obsidian'

export interface SavedPrompt {
  /** Filename without `.md` extension — used as the slash command name. */
  name: string
  /** Human-readable description from frontmatter (optional). */
  description: string
  /** Hint text for arguments, shown in the dropdown (optional). */
  argumentHint: string
  /** The prompt body text (everything after frontmatter). */
  body: string
  /** True when the body contains `$@` — cursor lands there after insert. */
  hasArgSlot: boolean
}

const PROMPTS_DIR = 'prompts'

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Only handles the simple key: value pairs we use (description, argument-hint).
 * Returns { frontmatter, body } where body is everything after the closing `---`.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const frontmatter: Record<string, string> = {}
  let body = content

  // Must start with `---` on the first line
  if (!content.startsWith('---')) return { frontmatter, body }

  const end = content.indexOf('\n---', 3)
  if (end === -1) return { frontmatter, body }

  const yamlBlock = content.slice(3, end)
  body = content.slice(end + 4).replace(/^\n/, '') // skip past `---\n`

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    let val = trimmed.slice(colon + 1).trim()
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    frontmatter[key] = val
  }

  return { frontmatter, body }
}

/**
 * Load all saved prompts from the vault's `prompts/` directory.
 * Returns an empty array if the directory doesn't exist. Flat scan only —
 * no subdirectories (per design decision).
 */
export async function loadPrompts(vault: Vault): Promise<SavedPrompt[]> {
  const folder = vault.getAbstractFileByPath(PROMPTS_DIR)
  if (!folder || !('children' in folder) || !folder.children) return []

  const prompts: SavedPrompt[] = []

  for (const file of folder.children as unknown as TFile[]) {
    if (!(file instanceof TFile) || file.extension !== 'md') continue
    const content = await vault.read(file)
    const { frontmatter, body } = parseFrontmatter(content)
    const name = file.basename
    prompts.push({
      name,
      description: frontmatter['description'] ?? '',
      argumentHint: frontmatter['argument-hint'] ?? '',
      body: body.trim(),
      hasArgSlot: body.includes('$@'),
    })
  }

  // Sort alphabetically for stable ordering
  prompts.sort((a, b) => a.name.localeCompare(b.name))
  return prompts
}

/**
 * Detect an active slash command ending at `cursor`.
 *
 * Returns the command text (after `/`, up to cursor) and the index of the
 * `/`, or null when there's no slash command. Only triggers when `/` sits at
 * a word boundary (start of text or after whitespace) — mirrors detectMention.
 */
export function detectSlashCommand(
  text: string,
  cursor: number
): { query: string; start: number } | null {
  if (cursor <= 0) return null
  let start = cursor
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const word = text.slice(start, cursor)
  if (word[0] !== '/') return null
  // `//` is a literal escape — don't trigger
  if (word[1] === '/') return null
  return { query: word.slice(1), start }
}

/**
 * Replace the `/query` span with the prompt body, handling `$@` substitution.
 * If the body contains `$@`, the arguments (text after the command name) replace it.
 * If no `$@`, arguments are appended at the end.
 * Returns the new textarea value and caret position.
 */
export function insertPrompt(
  value: string,
  start: number,
  queryLen: number,
  body: string,
  args: string
): { value: string; caret: number } {
  const end = start + 1 + queryLen
  let insert: string
  let caret: number

  if (body.includes('$@')) {
    insert = body.replace('$@', args)
    // Place cursor where $@ was (now replaced by args, or empty)
    const slotIndex = body.indexOf('$@')
    caret = start + slotIndex + args.length
  } else {
    insert = args ? `${body} ${args}` : body
    caret = start + insert.length
  }

  // Ensure trailing space if there's text after
  const after = value.slice(end)
  if (after && !after.startsWith('\n') && !after.startsWith(' ')) {
    insert += ' '
  }

  return {
    value: value.slice(0, start) + insert + value.slice(end),
    caret,
  }
}
