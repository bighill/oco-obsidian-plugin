import { str, safeGatewayUrl } from './lib'
import type { StreamItem } from './types'

/** Build a human-readable label for a tool call from the gateway. */
export function buildToolLabel(
  toolName: string,
  args: Record<string, unknown> | undefined
): { label: string; url?: string } {
  const a = args ?? {}
  switch (toolName) {
    case 'exec': {
      const cmd = str(a?.command)
      const short = cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd
      return { label: `🔧 ${short || 'Running command'}` }
    }
    case 'read':
    case 'Read': {
      const p = str(a?.path, str(a?.file_path))
      const name = p.split('/').pop() || 'file'
      return { label: `📄 Reading ${name}` }
    }
    case 'write':
    case 'Write': {
      const p = str(a?.path, str(a?.file_path))
      const name = p.split('/').pop() || 'file'
      return { label: `✏️ Writing ${name}` }
    }
    case 'edit':
    case 'Edit': {
      const p = str(a?.path, str(a?.file_path))
      const name = p.split('/').pop() || 'file'
      return { label: `✏️ Editing ${name}` }
    }
    case 'web_search': {
      const q = str(a?.query)
      return {
        label: `🔍 Searching "${q.length > 40 ? q.slice(0, 40) + '...' : q}"`,
      }
    }
    case 'web_fetch': {
      const rawUrl = str(a?.url)
      const safeUrl = safeGatewayUrl(rawUrl)
      const domain = safeUrl ? new URL(safeUrl).hostname : ''
      return {
        label: `🌐 Fetching ${domain || 'page'}`,
        url: safeUrl || undefined,
      }
    }
    case 'browser':
      return { label: '🌐 Using browser' }
    case 'image':
      return { label: '👁️ Viewing image' }
    case 'memory_search': {
      const q = str(a?.query)
      return {
        label: `🧠 Searching "${q.length > 40 ? q.slice(0, 40) + '...' : q}"`,
      }
    }
    case 'memory_get': {
      const p = str(a?.path)
      const name = p.split('/').pop() || 'memory'
      return { label: `🧠 Reading ${name}` }
    }
    case 'message':
      return { label: '💬 Sending message' }
    case 'sessions_spawn':
      return { label: '🤖 Spawning sub-agent' }
    default:
      return { label: toolName ? `⚡ ${toolName}` : 'Working' }
  }
}

/** Create a DOM element for a stream item (tool call or intermediary text). */
export function createStreamItemEl(item: StreamItem): HTMLElement {
  if (item.type === 'tool') {
    const el = createDiv({ cls: 'openclaw-tool-item' })
    const safeUrl = item.url ? safeGatewayUrl(item.url) : null
    if (safeUrl) {
      const link = el.createEl('a', {
        text: item.label,
        href: safeUrl,
        cls: 'openclaw-tool-link',
      })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        window.open(safeUrl, '_blank')
      })
    } else {
      el.textContent = item.label
    }
    return el
  } else {
    const details = createEl('details', { cls: 'openclaw-intermediary' })
    const summary = createEl('summary', {
      cls: 'openclaw-intermediary-summary',
    })
    const preview =
      item.text.length > 60 ? item.text.slice(0, 60) + '...' : item.text
    summary.textContent = preview
    details.appendChild(summary)
    const content = createDiv({ cls: 'openclaw-intermediary-content' })
    content.textContent = item.text
    details.appendChild(content)
    return details
  }
}
