import type { SuggestItem } from './types'

export class InlineSuggest {
  private containerEl: HTMLElement
  private listEl: HTMLElement
  private items: SuggestItem[] = []
  private selectedIndex = 0
  private open = false
  /** Called when the user picks an item (click or Enter). */
  onChoose: (item: SuggestItem) => void = () => {}

  constructor(host: HTMLElement) {
    this.containerEl = host.createDiv('openclaw-suggest')
    this.containerEl.addClass('oc-hidden')
    this.listEl = this.containerEl.createDiv('openclaw-suggest-list')
  }

  get isOpen(): boolean {
    return this.open
  }

  /** Show the dropdown with a fresh set of items (resets the highlight). */
  show(items: SuggestItem[]): void {
    this.items = items
    this.selectedIndex = 0
    this.open = true
    this.containerEl.removeClass('oc-hidden')
    this.render()
  }

  /** Replace items while staying open (keeps the highlight in range). */
  update(items: SuggestItem[]): void {
    this.items = items
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, items.length - 1)
    )
    this.render()
  }

  close(): void {
    this.open = false
    this.items = []
    this.containerEl.addClass('oc-hidden')
    this.listEl.empty()
  }

  /** Move the highlight by delta, wrapping around the list. */
  moveSelection(delta: number): void {
    if (this.items.length === 0) return
    const n = this.items.length
    this.selectedIndex = (this.selectedIndex + delta + n) % n
    this.render()
  }

  /** Return the highlighted item without closing. */
  current(): SuggestItem | null {
    return this.items[this.selectedIndex] ?? null
  }

  private render(): void {
    this.listEl.empty()
    if (this.items.length === 0) {
      this.listEl.createDiv({
        cls: 'openclaw-suggest-empty',
        text: 'No matching files',
      })
      return
    }
    this.items.forEach((item, i) => {
      const row = this.listEl.createDiv('openclaw-suggest-item')
      if (i === this.selectedIndex) row.addClass('is-selected')
      const slash = item.display.lastIndexOf('/')
      const name = slash >= 0 ? item.display.slice(slash + 1) : item.display
      const dir = slash >= 0 ? item.display.slice(0, slash + 1) : ''
      row.createSpan({ cls: 'openclaw-suggest-name', text: name })
      if (dir) row.createSpan({ cls: 'openclaw-suggest-path', text: dir })
      // Optional description (used by slash-command prompts)
      if (item.description) {
        row.createSpan({
          cls: 'openclaw-suggest-desc',
          text: item.description,
        })
      }
      row.addEventListener('mousedown', (e) => {
        // mousedown (not click) so the textarea doesn't blur first
        e.preventDefault()
        this.onChoose(item)
      })
      row.addEventListener('mouseenter', () => {
        this.selectedIndex = i
        this.render()
      })
    })
  }
}
