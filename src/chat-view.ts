import {
  ItemView,
  MarkdownRenderer,
  Notice,
  Platform,
  arrayBufferToBase64,
  prepareFuzzySearch,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from 'obsidian'
import { str, imageMimeFromExt, safeGatewayUrl } from './lib'
import {
  classifyFile,
  formatTextAttachment,
  detectMention,
  rankMentions,
  replaceMention,
  reconcileMentions,
  splitFileBlocks,
} from './at-mention'
import { buildToolLabel, createStreamItemEl } from './stream-ui'
import { createSvgIcon, SVG_HOME_18, SVG_RESET_10, SVG_RESET_11 } from './svgs'
import { generateId } from './crypto'
import { deleteSessionWithFallback } from './gateway-client'
import { InlineSuggest } from './inline-suggest'
import { ConfirmCloseModal } from './modals'
import { ModelPickerModal } from './model-picker-modal'
import {
  loadPrompts,
  detectSlashCommand,
  type SavedPrompt,
} from './prompt-loader'
import type OpenClawPlugin from './main'
import type {
  StreamItem,
  AgentInfo,
  GatewayPayload,
  SessionInfo,
  AgentListItem,
  ContentBlock,
  HistoryMessage,
  ChatMessage,
  SuggestItem,
} from './types'

/** Strip non-visible assistant sentinel responses. */
function cleanText(text: string): string {
  if (text === 'NO_REPLY' || text === 'HEARTBEAT_OK') return ''
  return text
}

export const VIEW_TYPE = 'openclaw-chat'

export class OpenClawChatView extends ItemView {
  plugin: OpenClawPlugin
  private topBarEl!: HTMLElement
  private messagesEl!: HTMLElement
  private tabBarEl!: HTMLElement
  private brainBtnEl!: HTMLElement
  private tabSessions: { key: string; label: string; pct: number }[] = []
  private renderingTabs = false
  private tabDeleteInProgress = false
  private inputEl!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private reconnectBtn!: HTMLButtonElement
  private abortBtn!: HTMLButtonElement
  private statusEl!: HTMLElement
  private pairingBannerEl: HTMLElement | null = null
  private messages: ChatMessage[] = []

  // ─── Per-session stream state ──────────────────────────────────────
  private streams = new Map<
    string,
    {
      runId: string
      text: string | null
      toolCalls: string[]
      items: StreamItem[]
      splitPoints: number[]
      lastDeltaTime: number
      compactTimer: number | null
      workingTimer: number | null
    }
  >()
  /** Map runId -> sessionKey so we can route stream events that lack sessionKey */
  private runToSession = new Map<string, string>()

  private streamEl: HTMLElement | null = null

  /** Local session key for this view. Independent so multiple tabs can have different sessions. */
  sessionKey = 'main'

  /** Get current active session key */
  private get activeSessionKey(): string {
    return this.sessionKey
  }
  /** Get stream state for active tab (if any) */
  private get activeStream() {
    return this.streams.get(this.sessionKey) ?? null
  }

  currentModel: string = ''
  currentModelSetAt: number = 0 // timestamp to prevent stale overwrites
  cachedSessionDisplayName: string = ''

  // Bar controls state
  private thinkingLevel: string = ''
  private verboseLevel: string = ''
  private thinkingDefault: string = ''
  private verboseDefault: string = ''
  private thinkChipEl: HTMLElement | null = null
  private verboseChipEl: HTMLElement | null = null

  // Agent switcher state
  private agents: AgentInfo[] = []
  private activeAgent: AgentInfo = {
    id: 'main',
    name: 'Agent',
    emoji: '🤖',
    creature: '',
  }
  private profileBtnEl: HTMLElement | null = null
  private profileDropdownEl: HTMLElement | null = null
  private typingEl!: HTMLElement
  private attachPreviewEl!: HTMLElement
  private suggest!: InlineSuggest
  private activeMention: { query: string; start: number } | null = null
  private slashSuggest!: InlineSuggest
  private activeSlash: { query: string; start: number } | null = null
  private savedPrompts: SavedPrompt[] = []
  private fileInputEl!: HTMLInputElement
  // `inline`/`token`: @-mention attachments shown as inline text (no chip). The
  // token is the exact `@path` string inserted; if it's gone from the textarea,
  // the attachment is reconciled away (see reconcileInlineMentions).
  private pendingAttachments: {
    name: string
    content: string
    vaultPath?: string
    base64?: string
    mimeType?: string
    inline?: boolean
    token?: string
  }[] = []
  private sending = false

  private bannerEl!: HTMLElement

  // Event handlers kept for cleanup in onClose()
  private hideDropdownHandler!: () => void
  private touchStartHandler!: (e: TouchEvent) => void
  private touchMoveHandler!: (e: TouchEvent) => void
  private touchEndHandler!: () => void

  /** Get the session key prefix for the active agent */
  get agentPrefix(): string {
    return `agent:${this.activeAgent.id}:`
  }

  constructor(leaf: WorkspaceLeaf, plugin: OpenClawPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType(): string {
    return VIEW_TYPE
  }

  getDisplayText(): string {
    return 'OcO'
  }

  getIcon(): string {
    return 'message-square'
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement
    container.empty()
    container.addClass('openclaw-chat-container')

    // Top bar with tabs + profile
    const topBar = container.createDiv('openclaw-top-bar')
    this.topBarEl = topBar

    // Tab bar (browser-like tabs)
    this.tabBarEl = topBar.createDiv('openclaw-tab-bar')
    this.tabBarEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.tabBarEl.scrollLeft += e.deltaY
      },
      { passive: false }
    )

    // Agent switcher button (top-right)
    this.profileBtnEl = topBar.createDiv('openclaw-agent-btn')
    this.profileBtnEl.setAttribute('aria-label', 'Switch agent')
    this.profileBtnEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleAgentSwitcher()
    })
    this.updateAgentButton()

    // Agent switcher dropdown (hidden by default)
    this.profileDropdownEl = container.createDiv('openclaw-agent-dropdown')
    this.profileDropdownEl.addClass('oc-hidden')

    // Close dropdown when clicking outside
    this.hideDropdownHandler = () => {
      if (this.profileDropdownEl) this.profileDropdownEl.addClass('oc-hidden')
    }
    activeDocument.addEventListener('click', this.hideDropdownHandler)

    // We'll render tabs after loading sessions
    void this.renderTabs()

    // Status banner (compaction, etc.) - hidden by default
    this.bannerEl = container.createDiv('openclaw-banner')
    this.bannerEl.addClass('oc-hidden')

    // Messages area
    this.messagesEl = container.createDiv('openclaw-messages')

    // Typing indicator (hidden by default)
    this.typingEl = container.createDiv('openclaw-typing')
    this.typingEl.addClass('oc-hidden')
    const typingDots = this.typingEl.createDiv('openclaw-typing-inner')
    typingDots.createSpan({ text: 'Thinking', cls: 'openclaw-typing-text' })
    const dotsEl = typingDots.createSpan('openclaw-typing-dots')
    dotsEl.createSpan('openclaw-dot')
    dotsEl.createSpan('openclaw-dot')
    dotsEl.createSpan('openclaw-dot')

    // Input area
    const inputArea = container.createDiv('openclaw-input-area')
    // Meta row (model pill above input)
    const inputMeta = inputArea.createDiv('openclaw-input-meta')
    this.brainBtnEl = inputMeta.createEl('button', {
      cls: 'openclaw-brain-btn',
      attr: { 'aria-label': 'Switch model' },
    })
    this.brainBtnEl.textContent = 'model'
    this.brainBtnEl.createSpan({ text: ' ▾', cls: 'openclaw-brain-btn-arrow' })
    this.brainBtnEl.addEventListener('click', () => this.openModelPicker())

    // Bar control chips (thinking + show steps)
    inputMeta.createSpan({ text: '·', cls: 'oc-bar-sep' })
    this.thinkChipEl = inputMeta.createSpan({
      text: 'think: default',
      cls: 'oc-bar-chip',
    })
    this.thinkChipEl.addEventListener('click', () => {
      void this.cycleBarControl('thinkingLevel', [
        '',
        'off',
        'low',
        'medium',
        'high',
      ])
    })
    inputMeta.createSpan({ text: '·', cls: 'oc-bar-sep' })
    this.verboseChipEl = inputMeta.createSpan({
      text: 'show steps: default',
      cls: 'oc-bar-chip',
    })
    this.verboseChipEl.addEventListener('click', () => {
      void this.cycleBarControl('verboseLevel', ['', 'off', 'on', 'full'])
    })
    const inputRow = inputArea.createDiv('openclaw-input-row')
    // Attach button + hidden file input
    const attachBtn = inputRow.createEl('button', {
      cls: 'openclaw-attach-btn',
      attr: { 'aria-label': 'Attach file' },
    })
    setIcon(attachBtn, 'plus')
    this.fileInputEl = inputArea.createEl('input', {
      cls: 'openclaw-file-input',
      attr: {
        type: 'file',
        accept:
          'image/*,.md,.txt,.json,.csv,.pdf,.yaml,.yml,.js,.ts,.py,.html,.css',
        multiple: 'true',
      },
    })
    this.fileInputEl.addClass('oc-hidden')
    this.fileInputEl.addEventListener(
      'change',
      () => void this.handleFileSelect()
    )
    attachBtn.addEventListener('click', () => this.fileInputEl.click())
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'openclaw-input',
      attr: { placeholder: 'Message...', rows: '1' },
    })
    // Attachment preview (hidden by default)
    this.attachPreviewEl = inputArea.createDiv('openclaw-attach-preview')
    this.attachPreviewEl.addClass('oc-hidden')
    // @-mention file picker dropdown (anchored to the input area)
    this.suggest = new InlineSuggest(inputArea)
    this.suggest.onChoose = (item) => void this.chooseMention(item)
    // Slash-command saved prompts dropdown
    this.slashSuggest = new InlineSuggest(inputArea)
    this.slashSuggest.onChoose = (item) => this.selectPrompt(item)
    this.abortBtn = inputRow.createEl('button', {
      cls: 'openclaw-abort-btn',
      attr: { 'aria-label': 'Stop' },
    })
    setIcon(this.abortBtn, 'square')
    this.abortBtn.addClass('oc-hidden')
    const sendWrapper = inputRow.createDiv('openclaw-send-wrapper')
    this.sendBtn = sendWrapper.createEl('button', {
      cls: 'openclaw-send-btn',
      attr: { 'aria-label': 'Send' },
    })
    setIcon(this.sendBtn, 'send')
    this.sendBtn.addClass('oc-opacity-low')
    this.reconnectBtn = sendWrapper.createEl('button', {
      cls: 'openclaw-reconnect-btn',
      attr: { 'aria-label': 'Reconnect' },
    })
    setIcon(this.reconnectBtn, 'refresh-cw')
    this.reconnectBtn.addClass('oc-hidden')
    this.reconnectBtn.addEventListener('click', () => {
      void this.plugin.connectGateway()
    })
    this.statusEl = sendWrapper.createSpan('openclaw-status-dot')

    // Events
    this.inputEl.addEventListener('keydown', (e) => {
      // @-mention dropdown captures navigation keys while open
      if (this.suggest.isOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          this.suggest.moveSelection(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          this.suggest.moveSelection(-1)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          this.closeMentionSuggest()
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const item = this.suggest.current()
          if (item) {
            e.preventDefault()
            void this.chooseMention(item)
            return
          }
        }
      }
      // Slash-command dropdown captures navigation keys while open
      if (this.slashSuggest.isOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          this.slashSuggest.moveSelection(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          this.slashSuggest.moveSelection(-1)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          this.closeSlashSuggest()
          return
        }
        if (e.key === 'Tab') {
          const item = this.slashSuggest.current()
          if (item) {
            e.preventDefault()
            this.selectPrompt(item)
            return
          }
        }
        if (e.key === 'Enter') {
          const item = this.slashSuggest.current()
          if (item) {
            // Select the prompt name into the input but don't send yet —
            // same as Tab. User hits Enter again to send.
            e.preventDefault()
            this.selectPrompt(item)
            return
          }
        }
      }
      if (e.key === 'Enter') {
        // Mobile: Enter always creates new line (use send button to send)
        // Desktop: Enter sends, Shift+Enter creates new line
        if (Platform.isMobile) {
          // Let Enter create a new line naturally
          return
        }
        if (!e.shiftKey) {
          e.preventDefault()
          void this.sendMessage()
        }
      }
    })
    this.inputEl.addEventListener('input', () => {
      this.autoResize()
      this.updateSendButton()
      this.updateMentionSuggest()
      void this.updateSlashSuggest()
      this.reconcileInlineMentions()
    })
    this.inputEl.addEventListener('blur', () => {
      if (this.suggest.isOpen) this.closeMentionSuggest()
      if (this.slashSuggest.isOpen) this.closeSlashSuggest()
    })
    this.inputEl.addEventListener('focus', () => {
      window.setTimeout(() => {
        this.inputEl.scrollIntoView({ block: 'end', behavior: 'smooth' })
      }, 300)
    })
    // Clipboard paste: capture images from clipboard
    this.inputEl.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) void this.handlePastedFile(file)
          return
        }
      }
    })
    this.sendBtn.addEventListener('click', () => {
      if (this.inputEl.value.trim() || this.pendingAttachments.length > 0) {
        void this.sendMessage()
      }
    })
    this.abortBtn.addEventListener('click', () => void this.abortMessage())

    // Initial state
    this.updateStatus()
    this.plugin.registerChatView(this)
    this.sessionKey = this.plugin.settings.sessionKey || 'main'

    // Init touch gestures for mobile
    this.initTouchGestures()

    if (this.plugin.gatewayConnected) {
      await this.loadHistory()
      void this.loadAgents()
      void this.loadDefaults()
    }
  }

  async onClose(): Promise<void> {
    this.plugin.unregisterChatView(this)

    // Remove global and element-level event listeners
    if (this.hideDropdownHandler) {
      activeDocument.removeEventListener('click', this.hideDropdownHandler)
    }
    if (this.touchStartHandler) {
      this.messagesEl.removeEventListener('touchstart', this.touchStartHandler)
    }
    if (this.touchMoveHandler) {
      this.messagesEl.removeEventListener('touchmove', this.touchMoveHandler)
    }
    if (this.touchEndHandler) {
      this.messagesEl.removeEventListener('touchend', this.touchEndHandler)
    }

    // Finish any active streams so their timers don't fire after the view is gone
    for (const key of [...this.streams.keys()]) {
      this.finishStream(key)
    }
    this.runToSession.clear()

    this.hidePairingBanner()
  }

  /** Reload the chat view when settings change externally (e.g. onboarding, settings tab) */
  syncFromSettings(): void {
    this.sessionKey = this.plugin.settings.sessionKey || 'main'
    this.messages = []
    this.messagesEl.empty()
    this.streamEl = null
    void this.loadHistory()
    void this.renderTabs()
    void this.updateContextMeter()
    this.updateStatus()
  }

  updateStatus(): void {
    if (!this.statusEl) return
    this.statusEl.removeClass('connected', 'disconnected')
    const connected = this.plugin.gatewayConnected
    this.statusEl.addClass(connected ? 'connected' : 'disconnected')

    // Surface the last connection error on hover
    const error = this.plugin.lastGatewayConnectError
    this.statusEl.setAttribute(
      'title',
      connected
        ? 'Connected'
        : error
          ? `Disconnected: ${error}`
          : 'Disconnected'
    )

    // Swap send button for reconnect when disconnected
    if (connected) {
      this.sendBtn.removeClass('oc-hidden')
      if (this.reconnectBtn) this.reconnectBtn.addClass('oc-hidden')
      this.inputEl.disabled = false
      this.inputEl.placeholder = 'Message...'
    } else {
      this.sendBtn.addClass('oc-hidden')
      if (this.reconnectBtn) this.reconnectBtn.removeClass('oc-hidden')
      this.inputEl.disabled = true
      this.inputEl.placeholder = 'Disconnected'
    }
  }

  showPairingBanner(): void {
    if (this.pairingBannerEl) return // already showing
    this.pairingBannerEl = this.messagesEl.parentElement!.createDiv(
      'openclaw-pairing-banner'
    )
    this.messagesEl.parentElement!.insertBefore(
      this.pairingBannerEl,
      this.messagesEl
    )

    this.pairingBannerEl.createDiv({
      text: '🔐 Device pairing required',
      cls: 'openclaw-pairing-title',
    })
    this.pairingBannerEl.createEl('p', {
      text: 'This device needs approval before it can connect.',
      cls: 'openclaw-pairing-desc',
    })

    const opt1Label = this.pairingBannerEl.createEl('p', {
      text: 'Run on the server:',
      cls: 'openclaw-pairing-option-label',
    })
    const copyBox = opt1Label.parentElement!.createDiv(
      'openclaw-pairing-copy-box'
    )
    copyBox.createEl('code', { text: 'openclaw devices approve --latest' })
    const copyBtn = copyBox.createSpan('openclaw-pairing-copy-btn')
    copyBtn.textContent = 'Copy'
    copyBox.addEventListener('click', () => {
      void navigator.clipboard
        .writeText('openclaw devices approve --latest')
        .then(() => {
          copyBtn.textContent = '✓'
          window.setTimeout(() => {
            copyBtn.textContent = 'Copy'
          }, 1500)
        })
    })

    this.pairingBannerEl.createEl('p', {
      text: 'Or tell your bot on another channel: "approve the pending device"',
      cls: 'openclaw-pairing-desc openclaw-pairing-alt',
    })

    const waitRow = this.pairingBannerEl.createDiv('openclaw-pairing-wait')
    waitRow.createDiv('openclaw-pairing-spinner')
    waitRow.createSpan({ text: 'Waiting for approval...' })
  }

  hidePairingBanner(): void {
    if (this.pairingBannerEl) {
      this.pairingBannerEl.remove()
      this.pairingBannerEl = null
    }
  }

  /** Fetch all agents from the gateway and load their identities */
  async loadAgents(): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    try {
      // Get agent list
      const result = (await this.plugin.gateway.request('agents.list', {})) as {
        agents?: AgentListItem[]
      } | null
      const agentList: AgentListItem[] = result?.agents || []
      if (agentList.length === 0) {
        agentList.push({ id: 'main' })
      }

      // Build agent info from gateway data only - no file parsing
      const agents: AgentInfo[] = []
      for (const a of agentList) {
        agents.push({
          id: a.id || 'main',
          name: a.name || a.id || 'Agent',
          emoji: '🤖',
          creature: '',
        })
      }

      this.agents = agents

      // Set active agent
      const savedId = this.plugin.settings.activeAgentId
      const active = agents.find((a) => a.id === savedId) || agents[0]
      if (active) {
        this.activeAgent = active
        if (this.plugin.settings.activeAgentId !== active.id) {
          this.plugin.settings.activeAgentId = active.id
          await this.plugin.saveSettings()
        }
      }

      this.updateAgentButton()
    } catch (e) {
      console.warn('[OcO] Failed to load agents:', e)
    }
  }

  /** Load agent defaults (thinking/show steps) from gateway config */
  async loadDefaults(): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    try {
      const result = await this.plugin.gateway.request('config.get', {})
      const raw = result as Record<string, unknown> | null
      const cfg = (raw?.config || raw || {}) as Record<string, unknown>
      let parsed: Record<string, unknown> = cfg
      if (raw && typeof raw.raw === 'string') {
        try {
          parsed = JSON.parse(raw.raw) as Record<string, unknown>
        } catch {
          /* use cfg */
        }
      }
      const agents = parsed?.agents as Record<string, unknown> | undefined
      const ad = (agents?.defaults || {}) as Record<string, unknown>
      this.thinkingDefault = str(ad?.thinkingDefault)
      this.verboseDefault = str(ad?.verboseDefault)
      this.updateBarControls()
    } catch {
      // config.get may not be available on all gateway versions
    }
  }

  /** Update the agent button to show the current agent emoji and name. */
  private updateAgentButton(): void {
    if (!this.profileBtnEl) return
    this.profileBtnEl.empty()
    this.profileBtnEl.createSpan({
      text: this.activeAgent.emoji || '🤖',
      cls: 'openclaw-agent-emoji',
    })
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

  /** Switch to a different agent */
  private async switchAgent(agent: AgentInfo): Promise<void> {
    if (agent.id === this.activeAgent.id) return
    this.activeAgent = agent
    this.plugin.settings.activeAgentId = agent.id
    this.sessionKey = 'main'
    this.plugin.settings.sessionKey = 'main' // reset to main session of new agent
    await this.plugin.saveSettings()
    this.updateAgentButton()
    // Finish any streams from the previous agent so their timers/UI don't leak over
    for (const key of [...this.streams.keys()]) {
      this.finishStream(key)
    }
    this.runToSession.clear()
    // Clear stale messages before loading the new agent's history
    this.messages = []
    this.messagesEl.empty()
    this.streamEl = null
    await this.loadHistory()
    await this.renderTabs()
  }

  /** Toggle the agent switcher dropdown */
  private toggleAgentSwitcher(): void {
    if (!this.profileDropdownEl) return
    if (this.agents.length <= 1) return
    const visible = !this.profileDropdownEl.hasClass('oc-hidden')
    if (visible) {
      this.profileDropdownEl.addClass('oc-hidden')
      return
    }
    this.profileDropdownEl.empty()

    for (const agent of this.agents) {
      const isActive = agent.id === this.activeAgent.id
      const item = this.profileDropdownEl.createDiv({
        cls: `openclaw-agent-item${isActive ? ' active' : ''}`,
      })
      item.createSpan({
        text: agent.emoji || '🤖',
        cls: 'openclaw-agent-item-emoji',
      })
      const info = item.createDiv('openclaw-agent-item-info')
      info.createDiv({ text: agent.name, cls: 'openclaw-agent-item-name' })
      if (agent.creature) {
        info.createDiv({
          text: agent.creature,
          cls: 'openclaw-agent-item-sub',
        })
      }
      if (!isActive) {
        item.addEventListener('click', () => {
          this.profileDropdownEl!.addClass('oc-hidden')
          void this.switchAgent(agent)
        })
      }
    }

    this.profileDropdownEl.removeClass('oc-hidden')
  }

  async loadHistory(): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    try {
      const result = (await this.plugin.gateway.request('chat.history', {
        sessionKey: `${this.agentPrefix}${this.sessionKey}`,
        limit: 200,
      })) as { messages?: HistoryMessage[] } | null
      if (result?.messages && Array.isArray(result.messages)) {
        this.messages = result.messages
          .filter(
            (m: HistoryMessage) => m.role === 'user' || m.role === 'assistant'
          )
          .map((m: HistoryMessage) => {
            const { text, images } = this.extractContent(m.content)
            return {
              role: m.role as 'user' | 'assistant',
              text,
              images,
              timestamp: m.timestamp ?? Date.now(),
              contentBlocks: Array.isArray(m.content) ? m.content : undefined,
            }
          })
          .filter(
            (m: ChatMessage) =>
              (m.text.trim() || m.images.length > 0) &&
              !m.text.startsWith('HEARTBEAT')
          )

        await this.renderMessages()
        void this.updateContextMeter()
      }
    } catch (e) {
      console.error('[OcO] Failed to load history:', e)
    }
  }

  private extractContent(content: string | ContentBlock[] | undefined): {
    text: string
    images: string[]
  } {
    let text = ''
    const images: string[] = []

    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text') {
          text += (text ? '\n' : '') + c.text
        } else if (c.type === 'tool_result') {
          // Extract text from tool_result content
          const trContent = c.content
          if (typeof trContent === 'string') {
            text += (text ? '\n' : '') + trContent
          } else if (Array.isArray(trContent)) {
            for (const tc of trContent) {
              if (tc?.type === 'text' && tc.text)
                text += (text ? '\n' : '') + tc.text
            }
          }
        } else if (c.type === 'image_url' && c.image_url?.url) {
          images.push(c.image_url.url)
        }
      }
    }

    // Extract vault image paths from "File saved at:" lines
    const savedAtRegex = /File saved at:\s*(.+?openclaw-attachments\/[^\s\n]+)/g
    let match
    while ((match = savedAtRegex.exec(text)) !== null) {
      // Try to resolve as vault-relative path
      const fullPath = match[1].trim()
      const vaultRelative = fullPath.includes('openclaw-attachments/')
        ? 'openclaw-attachments/' + fullPath.split('openclaw-attachments/')[1]
        : null
      if (vaultRelative) {
        try {
          const resourcePath =
            this.app.vault.adapter.getResourcePath(vaultRelative)
          if (resourcePath) images.push(resourcePath)
        } catch {
          /* ignore */
        }
      }
    }

    // Extract inline data URIs from text (legacy)
    const dataUriRegex = /(?:^|\n)data:(image\/[^;]+);base64,[A-Za-z0-9+/=\n]+/g
    while ((match = dataUriRegex.exec(text)) !== null) {
      images.push(match[0].replace(/^\n/, '').trim())
    }
    // Remove data URIs from text display
    text = text
      .replace(/\n?data:image\/[^;]+;base64,[A-Za-z0-9+/=\n]+/g, '')
      .trim()
    // Strip "NO_REPLY" / "HEARTBEAT_OK" sentinel responses
    if (text === 'NO_REPLY' || text === 'HEARTBEAT_OK') text = ''
    return { text, images }
  }

  private updateSendButton(): void {
    if (this.inputEl.value.trim() || this.pendingAttachments.length > 0) {
      this.sendBtn.setAttribute('aria-label', 'Send')
      this.sendBtn.removeClass('oc-opacity-low')
    } else {
      this.sendBtn.setAttribute('aria-label', 'Send')
      this.sendBtn.addClass('oc-opacity-low')
    }
  }

  async sendMessage(): Promise<void> {
    let text = this.inputEl.value.trim()
    const hasAttachments = this.pendingAttachments.length > 0
    if (!text && !hasAttachments) return
    if (this.sending) return
    if (!this.plugin.gateway?.connected) {
      new Notice('Not connected to OcO gateway')
      return
    }

    // Expand slash-command prompts before sending
    text = await this.expandSlashCommands(text)

    this.sending = true
    this.sendBtn.disabled = true
    this.inputEl.value = ''
    this.autoResize()

    // Build attachments for gateway
    let fullMessage = text
    const userImages: string[] = []
    const gatewayAttachments: {
      type: string
      mimeType: string
      content: string
    }[] = []
    if (this.pendingAttachments.length > 0) {
      for (const att of this.pendingAttachments) {
        if (att.base64 && att.mimeType) {
          // Image: send via attachments field (gateway saves to disk)
          gatewayAttachments.push({
            type: 'image',
            mimeType: att.mimeType,
            content: att.base64,
          })
          // Show preview in chat history
          userImages.push(`data:${att.mimeType};base64,${att.base64}`)
        } else {
          // Text files: append to message as before
          fullMessage = (fullMessage ? fullMessage + '\n\n' : '') + att.content
        }
      }
      if (!text) {
        text = `📎 ${this.pendingAttachments.map((a) => a.name).join(', ')}`
        if (!fullMessage) fullMessage = text
      }
      this.pendingAttachments = []
      this.attachPreviewEl.addClass('oc-hidden')
    }

    // Store the full message (incl. file blocks) locally so the just-sent
    // bubble collapses attachments the same way reloaded history does.
    this.messages.push({
      role: 'user',
      text: fullMessage || text,
      images: userImages,
      timestamp: Date.now(),
    })
    await this.renderMessages()

    const runId = generateId()
    const sendSessionKey = this.activeSessionKey

    // Create per-session stream state
    const ss = {
      runId,
      text: '' as string | null,
      toolCalls: [] as string[],
      items: [] as StreamItem[],
      splitPoints: [] as number[],
      lastDeltaTime: 0,
      compactTimer: null as number | null,
      workingTimer: null as number | null,
    }
    this.streams.set(sendSessionKey, ss)
    this.runToSession.set(runId, sendSessionKey)

    // Show UI for active tab
    this.abortBtn.removeClass('oc-hidden')
    this.typingEl.removeClass('oc-hidden')
    const thinkText = this.typingEl.querySelector('.openclaw-typing-text')
    if (thinkText) thinkText.textContent = 'Thinking'
    this.scrollToBottom()

    // Fallback: if no events at all after 15s, show generic status
    ss.compactTimer = window.setTimeout(() => {
      const current = this.streams.get(sendSessionKey)
      if (current?.runId === runId && !current.text) {
        // Only update DOM if this session is still active tab
        if (this.activeSessionKey === sendSessionKey) {
          const tt = this.typingEl.querySelector('.openclaw-typing-text')
          if (tt && tt.textContent === 'Thinking')
            tt.textContent = 'Still thinking'
        }
      }
    }, 15000)

    try {
      const sendParams: Record<string, unknown> = {
        sessionKey: `${this.agentPrefix}${sendSessionKey}`,
        message: fullMessage,
        deliver: false,
        idempotencyKey: runId,
      }
      if (gatewayAttachments.length > 0) {
        sendParams.attachments = gatewayAttachments
      }
      await this.plugin.gateway.request('chat.send', sendParams)
    } catch (e) {
      if (ss.compactTimer) window.clearTimeout(ss.compactTimer)
      this.messages.push({
        role: 'assistant',
        text: `Error: ${e}`,
        images: [],
        timestamp: Date.now(),
      })
      this.streams.delete(sendSessionKey)
      this.runToSession.delete(runId)
      this.abortBtn.addClass('oc-hidden')
      await this.renderMessages()
    } finally {
      this.sending = false
      this.sendBtn.disabled = false
    }
  }

  async abortMessage(): Promise<void> {
    const ss = this.activeStream
    if (!this.plugin.gateway?.connected || !ss) return
    try {
      await this.plugin.gateway.request('chat.abort', {
        sessionKey: `${this.agentPrefix}${this.activeSessionKey}`,
        runId: ss.runId,
      })
    } catch {
      // ignore
    }
  }

  async updateContextMeter(): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    try {
      const result = (await this.plugin.gateway.request(
        'sessions.list',
        {}
      )) as { sessions?: SessionInfo[] } | null
      const sessions: SessionInfo[] = result?.sessions || []
      // Find session matching current sessionKey (try exact match, then with agent prefix)
      const sk = this.sessionKey
      const session =
        sessions.find((s: SessionInfo) => s.key === sk) ||
        sessions.find(
          (s: SessionInfo) => s.key === `${this.agentPrefix}${sk}`
        ) ||
        sessions.find((s: SessionInfo) => s.key.endsWith(`:${sk}`))
      if (!session) return
      const used = session.totalTokens || 0
      const max = session.contextTokens || 200000
      const pct = Math.min(100, Math.round((used / max) * 100))
      // Update active tab meter bar
      const activeFill = this.tabBarEl?.querySelector(
        '.openclaw-tab.active .openclaw-tab-meter-fill'
      ) as HTMLElement
      if (activeFill) activeFill.setCssStyles({ width: pct + '%' })
      // Update model label from session data (but don't overwrite a recent manual switch)
      const fullModel = session.model || ''
      const modelCooldown = Date.now() - this.currentModelSetAt < 15000
      if (fullModel && fullModel !== this.currentModel && !modelCooldown) {
        this.currentModel = fullModel
        this.updateModelPill()
      }
      // Update session display name from gateway
      if (
        session.displayName &&
        session.displayName !== this.cachedSessionDisplayName
      ) {
        this.cachedSessionDisplayName = session.displayName
      }
      // Update bar controls (thinking/show steps) from session data
      this.updateBarControlsFromSession(session)
      // Detect session list changes and re-render tabs when needed
      const agentPrefix = this.agentPrefix
      const currentSessionKeys = new Set(
        sessions
          .filter((s: SessionInfo) => {
            if (!s.key.startsWith(agentPrefix)) return false
            const suffix = s.key.slice(agentPrefix.length)
            return !suffix.includes(':')
          })
          .map((s: SessionInfo) => s.key)
      )
      const trackedKeys = new Set(
        this.tabSessions.map((t) => `${agentPrefix}${t.key}`)
      )
      const added = [...currentSessionKeys].some((k) => !trackedKeys.has(k))
      const removed = [...trackedKeys].some((k) => !currentSessionKeys.has(k))
      if ((added || removed) && !this.tabDeleteInProgress) {
        // If viewing a session that no longer exists, switch back to main
        if (removed && !currentSessionKeys.has(`${agentPrefix}${sk}`)) {
          this.sessionKey = 'main'
          this.plugin.settings.sessionKey = 'main'
          await this.plugin.saveSettings()
          this.messages = []
          this.messagesEl.empty()
          await this.loadHistory()
          this.updateStatus()
        }
        await this.renderTabs()
      }
    } catch {
      /* ignore */
    }
  }

  updateModelPill(): void {
    const model = this.currentModel
      ? this.shortModelName(this.currentModel)
      : 'model'
    if (this.brainBtnEl) {
      this.brainBtnEl.empty()
      this.brainBtnEl.appendText(model)
      this.brainBtnEl.createSpan({
        text: ' ▾',
        cls: 'openclaw-brain-btn-arrow',
      })
    }
  }

  // ─── Bar Controls (thinking / show steps) ────────────────────────────

  private barControlDefaultLabel(defaultVal: string): string {
    return defaultVal ? `default (${defaultVal})` : 'default'
  }

  updateBarControls(): void {
    if (this.thinkChipEl) {
      const label =
        this.thinkingLevel || this.barControlDefaultLabel(this.thinkingDefault)
      this.thinkChipEl.textContent = 'think: ' + label
      this.thinkChipEl.toggleClass('oc-bar-chip-active', !!this.thinkingLevel)
    }
    if (this.verboseChipEl) {
      const label =
        this.verboseLevel || this.barControlDefaultLabel(this.verboseDefault)
      this.verboseChipEl.textContent = 'show steps: ' + label
      this.verboseChipEl.toggleClass('oc-bar-chip-active', !!this.verboseLevel)
    }
  }

  private async cycleBarControl(
    field: 'thinkingLevel' | 'verboseLevel',
    cycle: string[]
  ): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    const current =
      field === 'thinkingLevel' ? this.thinkingLevel : this.verboseLevel
    const idx = cycle.indexOf(current)
    const next = cycle[(idx + 1) % cycle.length]
    const patch: Record<string, string | null> = {}
    patch[field] = next || null // null = clear override, inherit default
    try {
      await this.plugin.gateway.request('sessions.patch', {
        key: `${this.agentPrefix}${this.activeSessionKey}`,
        ...patch,
      })
      if (field === 'thinkingLevel') this.thinkingLevel = next
      else this.verboseLevel = next
      this.updateBarControls()
    } catch (err: unknown) {
      new Notice(
        `Failed to update ${field}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private updateBarControlsFromSession(session: SessionInfo): void {
    this.thinkingLevel = session.thinkingLevel || ''
    this.verboseLevel = session.verboseLevel || ''
    if (session.thinkingDefault) this.thinkingDefault = session.thinkingDefault
    if (session.verboseDefault) this.verboseDefault = session.verboseDefault
    this.updateBarControls()
  }

  private switchToTab(tab: { key: string; label: string; pct: number }): void {
    void (async () => {
      this.streamEl = null
      this.typingEl.addClass('oc-hidden')
      this.abortBtn.addClass('oc-hidden')
      this.hideBanner()
      this.sessionKey = tab.key
      this.plugin.settings.sessionKey = tab.key
      await this.plugin.saveSettings()
      this.messages = []
      this.messagesEl.empty()
      this.cachedSessionDisplayName = tab.label
      await this.loadHistory()
      this.restoreStreamUI()
      await this.updateContextMeter()
      void this.renderTabs()
      this.updateStatus()
    })()
  }

  private async resetTabAction(tab: {
    key: string
    label: string
    pct: number
  }): Promise<void> {
    if (!this.plugin.gateway?.connected) return
    const currentKey = this.sessionKey
    const isHome = tab.key === 'main'
    const title = isHome ? 'Reset Home tab?' : `Reset "${tab.label}"?`
    if (!this.isCloseConfirmDisabled()) {
      const confirmed = await this.confirmTabClose(
        title,
        'This will clear the conversation.'
      )
      if (!confirmed) return
    }
    try {
      await this.plugin.gateway.request('chat.send', {
        sessionKey: `${this.agentPrefix}${tab.key}`,
        message: '/reset',
        deliver: false,
        idempotencyKey: 'reset-' + Date.now(),
      })
      new Notice(isHome ? 'Home tab reset' : `Reset: ${tab.label}`)
      if (tab.key === currentKey) {
        this.messages = []
        this.messagesEl.empty()
      }
      await this.updateContextMeter()
      await this.renderTabs()
    } catch (err: unknown) {
      new Notice(
        `Reset failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async closeTabAction(tab: {
    key: string
    label: string
    pct: number
  }): Promise<void> {
    if (!this.plugin.gateway?.connected || this.tabDeleteInProgress) return
    const currentKey = this.sessionKey
    if (!this.isCloseConfirmDisabled()) {
      const confirmed = await this.confirmTabClose(
        'Close tab?',
        `Close "${tab.label}"? Chat history will be lost.`
      )
      if (!confirmed) return
    }
    this.tabDeleteInProgress = true
    try {
      const deleted = await deleteSessionWithFallback(
        this.plugin.gateway,
        `${this.agentPrefix}${tab.key}`
      )
      new Notice(
        deleted ? `Closed: ${tab.label}` : `Could not delete: ${tab.label}`
      )
    } catch (err: unknown) {
      new Notice(
        `Close failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    this.finishStream(tab.key)
    if (tab.key === currentKey) {
      this.sessionKey = 'main'
      this.plugin.settings.sessionKey = 'main'
      await this.plugin.saveSettings()
      this.messages = []
      this.messagesEl.empty()
      await this.loadHistory()
      this.restoreStreamUI()
    }
    this.tabDeleteInProgress = false
    await this.renderTabs()
    await this.updateContextMeter()
  }

  private async createNewTabAction(): Promise<void> {
    const existingKeys = new Set(this.tabSessions.map((t) => t.key))
    let nextNum = 1
    while (existingKeys.has(`tab-${nextNum}`)) nextNum++
    const sessionKey = `tab-${nextNum}`
    try {
      await this.plugin.gateway?.request('chat.send', {
        sessionKey: `${this.agentPrefix}${sessionKey}`,
        message: '/new',
        deliver: false,
        idempotencyKey: 'newtab-' + Date.now(),
      })
      await new Promise((r) => window.setTimeout(r, 500))
      try {
        await this.plugin.gateway?.request('sessions.patch', {
          key: `${this.agentPrefix}${sessionKey}`,
          label: 'Untitled',
        })
      } catch {
        /* label optional */
      }
      // Switch to it - clear old tab's stream UI
      this.streamEl = null
      this.typingEl.addClass('oc-hidden')
      this.abortBtn.addClass('oc-hidden')
      this.hideBanner()

      this.sessionKey = sessionKey
      this.plugin.settings.sessionKey = sessionKey
      await this.plugin.saveSettings()
      this.messages = []
      this.messagesEl.empty()
      await this.renderTabs()
      await this.updateContextMeter()
      new Notice('New tab')
    } catch (err: unknown) {
      new Notice(
        `Failed to create tab: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async renderTabs(): Promise<void> {
    if (!this.tabBarEl || this.renderingTabs) return
    this.renderingTabs = true
    try {
      await this._renderTabsInner()
    } finally {
      this.renderingTabs = false
    }
  }

  private async _renderTabsInner(): Promise<void> {
    this.tabBarEl.empty()
    const currentKey = this.sessionKey

    // Fetch sessions from gateway
    let sessions: SessionInfo[] = []
    if (this.plugin.gateway?.connected) {
      try {
        const result = (await this.plugin.gateway.request(
          'sessions.list',
          {}
        )) as { sessions?: SessionInfo[] } | null
        sessions = result?.sessions || []
      } catch {
        /* use empty */
      }
    }

    // Filter: only show user conversation sessions (suffix has no colons)
    // This excludes channel sessions (telegram:, discord:, webchat:, etc.),
    // cron jobs, and sub-agents - all of which have colons in their suffix.
    const agentPrefix = this.agentPrefix
    const convSessions = sessions.filter((s) => {
      if (!s.key.startsWith(agentPrefix)) return false
      const suffix = s.key.slice(agentPrefix.length)
      return !suffix.includes(':')
    })

    // Build tab list - ensure "main" is always first
    this.tabSessions = []
    const mainSession = convSessions.find(
      (s) => s.key === `${this.agentPrefix}main`
    )
    if (mainSession) {
      const used = mainSession.totalTokens || 0
      const max = mainSession.contextTokens || 200000
      this.tabSessions.push({
        key: 'main',
        label: 'Home',
        pct: Math.min(100, Math.round((used / max) * 100)),
      })
    } else {
      this.tabSessions.push({ key: 'main', label: 'Home', pct: 0 })
    }

    // Add other sessions in creation order (oldest first), then apply saved order
    const others = convSessions
      .filter((s) => s.key.slice(agentPrefix.length) !== 'main')
      .sort(
        (a, b) =>
          (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0)
      )

    const savedOrder = this.plugin.settings.tabOrder || []
    if (savedOrder.length > 0) {
      const orderMap = new Map<string, number>(savedOrder.map((k, i) => [k, i]))
      others.sort((a, b) => {
        const skA = a.key.slice(agentPrefix.length)
        const skB = b.key.slice(agentPrefix.length)
        const oA = orderMap.has(skA) ? orderMap.get(skA)! : 9999
        const oB = orderMap.has(skB) ? orderMap.get(skB)! : 9999
        if (oA !== oB) return oA - oB
        return (
          (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0)
        )
      })
    }

    for (const s of others) {
      const sk = s.key.slice(agentPrefix.length)
      const used = s.totalTokens || 0
      const max = s.contextTokens || 200000
      const pct = Math.min(100, Math.round((used / max) * 100))
      const label = s.label || s.displayName || 'Untitled'
      this.tabSessions.push({ key: sk, label, pct })
    }

    // Render each tab
    for (const tab of this.tabSessions) {
      const isCurrent = tab.key === currentKey
      const isHome = tab.key === 'main'
      const tabCls = `openclaw-tab${isCurrent ? ' active' : ''}${isHome ? ' openclaw-tab-home' : ''}`
      const tabEl = this.tabBarEl.createDiv({ cls: tabCls })

      // Row: label + action button
      const row = tabEl.createDiv({ cls: 'openclaw-tab-row' })
      const labelSpan = row.createSpan({ cls: 'openclaw-tab-label' })

      if (isHome) {
        // Home tab: house icon only, non-renameable
        createSvgIcon(labelSpan, SVG_HOME_18, { style: 'vertical-align:-3px' })
      } else {
        labelSpan.textContent = tab.label
        // Double-click to rename (non-Home tabs only)
        labelSpan.title = 'Double-click to rename'
        labelSpan.addEventListener('dblclick', (e) => {
          e.stopPropagation()
          const input = createEl('input', { cls: 'openclaw-tab-label-input' })
          input.value = tab.label
          input.maxLength = 30
          labelSpan.replaceWith(input)
          input.focus()
          input.select()
          const finish = async (save: boolean) => {
            const newName = input.value.trim()
            if (save && newName && newName !== tab.label) {
              try {
                await this.plugin.gateway?.request('sessions.patch', {
                  key: `${this.agentPrefix}${tab.key}`,
                  label: newName,
                })
                tab.label = newName
              } catch {
                /* keep old name */
              }
            }
            input.replaceWith(labelSpan)
            labelSpan.textContent = tab.label
            void this.renderTabs()
          }
          input.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') {
              ev.preventDefault()
              void finish(true)
            }
            if (ev.key === 'Escape') {
              ev.preventDefault()
              void finish(false)
            }
          })
          input.addEventListener('blur', () => void finish(true))
        })
      }
      row.appendChild(labelSpan)

      // Action button: Home gets refresh icon, others get reset + close
      if (isHome) {
        const resetBtn = row.createSpan({ cls: 'openclaw-tab-close' })
        createSvgIcon(resetBtn, SVG_RESET_11, { style: 'vertical-align:-1px' })
        resetBtn.title = 'Reset conversation'
        resetBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          void this.resetTabAction(tab)
        })
      } else {
        // Other tabs: reset button (↻) + close button (×)
        const tabResetBtn = row.createSpan({
          cls: 'openclaw-tab-close openclaw-tab-reset',
        })
        createSvgIcon(tabResetBtn, SVG_RESET_10, {
          style: 'vertical-align:-1px',
        })
        tabResetBtn.title = 'Reset conversation'
        tabResetBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          void this.resetTabAction(tab)
        })

        const tabCloseBtn = row.createSpan({
          text: '×',
          cls: 'openclaw-tab-close',
        })
        tabCloseBtn.title = 'Close tab'
        tabCloseBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          void this.closeTabAction(tab)
        })
      }

      // Progress bar (gray container, black fill)
      const meter = tabEl.createDiv({ cls: 'openclaw-tab-meter' })
      const fill = meter.createDiv({ cls: 'openclaw-tab-meter-fill' })
      fill.setCssStyles({ width: tab.pct + '%' })

      // Drag to reorder (non-Home tabs only)
      if (!isHome) {
        tabEl.draggable = true
        tabEl.addEventListener('dragstart', (e: DragEvent) => {
          e.dataTransfer?.setData('text/plain', tab.key)
          tabEl.addClass('oc-dragging')
        })
        tabEl.addEventListener('dragend', () => {
          tabEl.removeClass('oc-dragging')
          this.tabBarEl
            .querySelectorAll('.oc-drag-over')
            .forEach((el: Element) =>
              (el as HTMLElement).classList.remove('oc-drag-over')
            )
        })
        tabEl.addEventListener('dragover', (e: DragEvent) => {
          e.preventDefault()
          tabEl.addClass('oc-drag-over')
        })
        tabEl.addEventListener('dragleave', () => {
          tabEl.removeClass('oc-drag-over')
        })
        tabEl.addEventListener('drop', (e: DragEvent) => {
          e.preventDefault()
          tabEl.removeClass('oc-drag-over')
          const draggedKey = e.dataTransfer?.getData('text/plain')
          if (draggedKey && draggedKey !== tab.key) {
            void this.reorderTabs(draggedKey, tab.key)
          }
        })
      }

      // Click to switch
      if (!isCurrent) {
        tabEl.addEventListener('click', () => this.switchToTab(tab))
      }
    }

    // + button to add new tab
    const addBtn = this.tabBarEl.createDiv({
      cls: 'openclaw-tab openclaw-tab-add',
    })
    addBtn.createSpan({ text: '+', cls: 'openclaw-tab-label' })
    addBtn.addEventListener('click', () => void this.createNewTabAction())
  }

  // ─── Confirm close dialog ──────────────────────────────────────────

  private isCloseConfirmDisabled(): boolean {
    return this.plugin.getCloseConfirmDisabled()
  }

  private confirmTabClose(title: string, msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmCloseModal(
        this.app,
        title,
        msg,
        (result, dontAsk) => {
          if (result && dontAsk) {
            this.plugin.setCloseConfirmDisabled(true)
          }
          resolve(result)
        }
      )
      modal.open()
    })
  }

  // ─── Touch gestures ──────────────────────────────────────────────

  private initTouchGestures(): void {
    let touchStartY = 0
    let pulling = false

    this.touchStartHandler = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY
      pulling = false
    }
    this.messagesEl.addEventListener('touchstart', this.touchStartHandler, {
      passive: true,
    })

    this.touchMoveHandler = (e: TouchEvent) => {
      const deltaY = e.touches[0].clientY - touchStartY
      if (this.messagesEl.scrollTop <= 0 && deltaY > 60) {
        pulling = true
      }
    }
    this.messagesEl.addEventListener('touchmove', this.touchMoveHandler, {
      passive: true,
    })

    this.touchEndHandler = () => {
      // Pull-to-refresh
      if (pulling) {
        pulling = false
        this.messages = []
        this.messagesEl.empty()
        void this.loadHistory().then(() => this.updateContextMeter())
        new Notice('Refreshed')
      }
    }
    this.messagesEl.addEventListener('touchend', this.touchEndHandler, {
      passive: true,
    })
  }

  shortModelName(fullId: string): string {
    // "anthropic/claude-opus-4-6" -> "opus-4-6" (selected display)
    // Strip provider prefix, strip "claude-" prefix for brevity
    const model = fullId.includes('/') ? fullId.split('/')[1] : fullId
    return model.replace(/^claude-/, '')
  }

  openModelPicker(): void {
    new ModelPickerModal(this.app, this.plugin, this).open()
  }

  async reorderTabs(draggedKey: string, targetKey: string): Promise<void> {
    const keys = this.tabSessions
      .filter((t) => t.key !== 'main')
      .map((t) => t.key)
    const fromIdx = keys.indexOf(draggedKey)
    const toIdx = keys.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) return
    keys.splice(fromIdx, 1)
    keys.splice(toIdx, 0, draggedKey)
    this.plugin.settings.tabOrder = keys
    await this.plugin.saveSettings()
    await this.renderTabs()
  }

  /** Recompute the @-mention dropdown from the current caret position. */
  private updateMentionSuggest(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length
    const mention = detectMention(this.inputEl.value, cursor)
    if (!mention) {
      this.closeMentionSuggest()
      return
    }
    this.activeMention = mention
    const items = this.mentionItems(mention.query)
    if (this.suggest.isOpen) this.suggest.update(items)
    else this.suggest.show(items)
  }

  private closeMentionSuggest(): void {
    this.activeMention = null
    this.suggest.close()
  }

  // ─── Slash-command saved prompts ─────────────────────────────────

  /** Recompute the slash-command dropdown from the current caret position. */
  private async updateSlashSuggest(): Promise<void> {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length
    const slash = detectSlashCommand(this.inputEl.value, cursor)
    if (!slash) {
      this.closeSlashSuggest()
      return
    }
    this.activeSlash = slash
    // Refresh prompts from disk each time the dropdown opens
    if (this.savedPrompts.length === 0 || slash.query.length === 0) {
      this.savedPrompts = await loadPrompts(this.app.vault)
    }
    const items = this.slashPromptItems(slash.query)
    if (items.length === 0) {
      this.closeSlashSuggest()
      return
    }
    if (this.slashSuggest.isOpen) this.slashSuggest.update(items)
    else this.slashSuggest.show(items)
  }

  private closeSlashSuggest(): void {
    this.activeSlash = null
    this.slashSuggest.close()
  }

  /** Filter saved prompts by fuzzy-matching name + description. */
  private slashPromptItems(query: string): SuggestItem[] {
    if (!query) {
      return this.savedPrompts.map((p) => ({
        path: p.name,
        display: `/${p.name}`,
        description: p.description,
        argumentHint: p.argumentHint,
      }))
    }
    const matcher = prepareFuzzySearch(query)
    return this.savedPrompts
      .map((p) => {
        const result = matcher(`${p.name} ${p.description}`)
        return { prompt: p, score: result ? result.score : null }
      })
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score! - a.score!)
      .slice(0, 50)
      .map((x) => ({
        path: x.prompt.name,
        display: `/${x.prompt.name}`,
        description: x.prompt.description,
        argumentHint: x.prompt.argumentHint,
      }))
  }

  /**
   * Replace the `/query` text in the input with `/prompt-name`,
   * close the dropdown, and place cursor after the command.
   * Expansion to the prompt body happens at submit time.
   */
  private selectPrompt(item: SuggestItem): void {
    const slash = this.activeSlash
    this.closeSlashSuggest()
    if (!slash) return

    const token = `/${item.path}`
    const { value, caret } = replaceMention(
      this.inputEl.value,
      slash.start,
      slash.query.length,
      `${token} `
    )
    this.inputEl.value = value
    this.inputEl.setSelectionRange(caret, caret)
    this.autoResize()
    this.updateSendButton()
  }

  /**
   * Expand any `/name` slash command in the text to its prompt body.
   * `$@` in the body is replaced by args typed after the command name.
   * Returns the expanded text, or the original if no command matched.
   */
  private async expandSlashCommands(text: string): Promise<string> {
    const match = /^(\/[a-zA-Z0-9_-]+)(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return text
    const name = match[1].slice(1) // strip leading /
    const args = (match[2] ?? '').trim()
    const prompts = await loadPrompts(this.app.vault)
    const prompt = prompts.find((p) => p.name === name)
    if (!prompt) return text
    if (prompt.body.includes('$@')) {
      return prompt.body.replace('$@', args)
    }
    return args ? `${prompt.body} ${args}` : prompt.body
  }

  /** Rank vault files for the dropdown, using Obsidian fuzzy search when querying. */
  private mentionItems(query: string): SuggestItem[] {
    const files = this.app.vault
      .getFiles()
      .map((f) => ({ path: f.path, mtime: f.stat.mtime }))
    const matcher = query ? prepareFuzzySearch(query) : null
    const score = (_q: string, path: string): number | null => {
      if (!matcher) return 0
      const result = matcher(path)
      return result ? result.score : null
    }
    return rankMentions(files, query, score, 50).map((f) => ({
      path: f.path,
      display: f.path,
    }))
  }

  /** Handle a file chosen from the @-mention dropdown. */
  private async chooseMention(item: SuggestItem): Promise<void> {
    const mention = this.activeMention
    this.closeMentionSuggest()

    const file = this.app.vault.getAbstractFileByPath(item.path)
    if (!(file instanceof TFile)) return

    // Insert the mention as inline text (`@<path>`) where the @query was.
    const token = `@${file.path}`
    if (mention) this.insertMentionText(mention, token)

    try {
      const base = { name: file.name, inline: true, token }
      const kind = classifyFile({ name: file.name, mimeType: '' })
      if (kind === 'image') {
        const base64 = arrayBufferToBase64(
          await this.app.vault.readBinary(file)
        )
        this.pendingAttachments.push({
          ...base,
          content: `[Attached image: ${file.name}]`,
          base64,
          mimeType: imageMimeFromExt(file.extension),
          vaultPath: file.path,
        })
      } else if (kind === 'text') {
        const content = await this.app.vault.read(file)
        this.pendingAttachments.push({
          ...base,
          content: formatTextAttachment(file.path, content),
        })
      } else {
        this.pendingAttachments.push({
          ...base,
          content: `[Attached file: ${file.name}]`,
        })
      }
      this.updateSendButton()
    } catch (e) {
      new Notice(`Failed to attach ${file.name}: ${e}`)
    }
  }

  /** Replace the `@query` with inline mention text, caret left after it. */
  private insertMentionText(
    mention: { query: string; start: number },
    token: string
  ): void {
    const { value, caret } = replaceMention(
      this.inputEl.value,
      mention.start,
      mention.query.length,
      `${token} `
    )
    this.inputEl.value = value
    this.inputEl.setSelectionRange(caret, caret)
    this.autoResize()
    this.updateSendButton()
  }

  /** Drop any inline @-mention attachment whose token is no longer in the textarea. */
  private reconcileInlineMentions(): void {
    const survivors = reconcileMentions(
      this.inputEl.value,
      this.pendingAttachments
    )
    if (survivors.length !== this.pendingAttachments.length) {
      this.pendingAttachments = survivors
      this.updateSendButton()
    }
  }

  async handleFileSelect(): Promise<void> {
    const files = this.fileInputEl.files
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      try {
        const kind = classifyFile({ name: file.name, mimeType: file.type })

        if (kind === 'image') {
          const resized = await this.resizeImage(file, 2048, 0.85)
          this.pendingAttachments.push({
            name: file.name,
            content: `[Attached image: ${file.name}]`,
            base64: resized.base64,
            mimeType: resized.mimeType,
          })
        } else if (kind === 'text') {
          const content = await file.text()
          this.pendingAttachments.push({
            name: file.name,
            content: formatTextAttachment(file.name, content),
          })
        } else {
          this.pendingAttachments.push({
            name: file.name,
            content: `[Attached file: ${file.name} (${file.type || 'unknown type'}, ${Math.round(file.size / 1024)}KB)]`,
          })
        }
      } catch (e) {
        new Notice(`Failed to attach ${file.name}: ${e}`)
      }
    }

    // Update preview
    this.renderAttachPreview()
    this.fileInputEl.value = ''
  }

  async handlePastedFile(file: File): Promise<void> {
    try {
      const ext = file.type.split('/')[1] || 'png'
      const resized = await this.resizeImage(file, 2048, 0.85)
      this.pendingAttachments.push({
        name: `clipboard.${ext}`,
        content: `[Attached image: clipboard.${ext}]`,
        base64: resized.base64,
        mimeType: resized.mimeType,
      })
      this.renderAttachPreview()
    } catch (e) {
      new Notice(`Failed to paste image: ${e}`)
    }
  }

  private async resizeImage(
    file: File,
    maxSide: number,
    quality: number
  ): Promise<{ base64: string; mimeType: string }> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        let { width, height } = img
        if (width > maxSide || height > maxSide) {
          const scale = maxSide / Math.max(width, height)
          width = Math.round(width * scale)
          height = Math.round(height * scale)
        }
        const canvas = createEl('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('No canvas context'))
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const base64 = dataUrl.split(',')[1]
        resolve({ base64, mimeType: 'image/jpeg' })
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load image'))
      }
      img.src = url
    })
  }

  private renderAttachPreview(): void {
    this.attachPreviewEl.empty()
    // Inline @-mentions live in the textarea, not the chip strip.
    const chipped = this.pendingAttachments.filter((a) => !a.inline)
    if (chipped.length === 0) {
      this.attachPreviewEl.addClass('oc-hidden')
      return
    }
    this.attachPreviewEl.removeClass('oc-hidden')

    for (let i = 0; i < chipped.length; i++) {
      const att = chipped[i]
      const chip = this.attachPreviewEl.createDiv('openclaw-attach-chip')

      // Show thumbnail for images
      if (att.base64 && att.mimeType) {
        const src = `data:${att.mimeType};base64,${att.base64}`
        chip.createEl('img', { cls: 'openclaw-attach-thumb', attr: { src } })
      } else if (att.vaultPath) {
        try {
          const src = this.app.vault.adapter.getResourcePath(att.vaultPath)
          if (src)
            chip.createEl('img', {
              cls: 'openclaw-attach-thumb',
              attr: { src },
            })
        } catch {
          /* ignore */
        }
      }

      chip.createSpan({ text: att.name, cls: 'openclaw-attach-name' })
      const removeBtn = chip.createEl('button', {
        text: '✕',
        cls: 'openclaw-attach-remove',
      })
      removeBtn.addEventListener('click', () => {
        // Splice the actual object - `chipped` is a filtered view, so its index
        // doesn't line up with the backing array.
        const at = this.pendingAttachments.indexOf(att)
        if (at >= 0) this.pendingAttachments.splice(at, 1)
        this.renderAttachPreview()
      })
    }
  }

  private appendToolCall(label: string, url?: string, active = false): void {
    const el = createDiv({
      cls: 'openclaw-tool-item' + (active ? ' openclaw-tool-active' : ''),
    })
    const safeUrl = url ? safeGatewayUrl(url) : null
    if (safeUrl) {
      const link = el.createEl('a', {
        text: label,
        href: safeUrl,
        cls: 'openclaw-tool-link',
      })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        window.open(safeUrl, '_blank')
      })
    } else {
      el.createSpan({ text: label })
    }
    if (active) {
      const dots = el.createSpan({ cls: 'openclaw-tool-dots' })
      dots.createSpan('openclaw-dot')
      dots.createSpan('openclaw-dot')
      dots.createSpan('openclaw-dot')
    }
    this.messagesEl.appendChild(el)
    this.scrollToBottom()
  }

  private deactivateLastToolItem(): void {
    const items = this.messagesEl.querySelectorAll('.openclaw-tool-active')
    const last = items[items.length - 1]
    if (last) {
      last.removeClass('openclaw-tool-active')
      const dots = last.querySelector('.openclaw-tool-dots')
      if (dots) dots.remove()
    }
  }

  private showBanner(text: string): void {
    if (!this.bannerEl) return
    this.bannerEl.textContent = text
    this.bannerEl.removeClass('oc-hidden')
  }

  private hideBanner(): void {
    if (!this.bannerEl) return
    this.bannerEl.addClass('oc-hidden')
  }

  /** Resolve which session a stream/agent event belongs to */
  private resolveStreamSession(payload: GatewayPayload): string | null {
    // Try sessionKey on payload first
    const sk = str(payload.sessionKey)
    if (sk) {
      // Normalize: strip agent:main: prefix
      const prefix = this.agentPrefix
      const normalized = sk.startsWith(prefix) ? sk.slice(prefix.length) : sk
      if (this.streams.has(normalized)) return normalized
    }
    // Fall back to runId mapping
    const data = payload.data as GatewayPayload | undefined
    const runId = str(payload.runId, str(data?.runId))
    if (runId && this.runToSession.has(runId))
      return this.runToSession.get(runId)!
    // Last resort: if only one stream is active, use that
    if (this.streams.size === 1) {
      const next = this.streams.keys().next()
      return next.done ? null : next.value
    }
    return null
  }

  handleStreamEvent(payload: GatewayPayload): void {
    const stream = str(payload.stream)
    const state = str(payload.state)
    const payloadData = payload.data as GatewayPayload | undefined

    const sessionKey = this.resolveStreamSession(payload)
    const isActiveTab = sessionKey === this.activeSessionKey

    // Compaction can arrive without an active stream
    if (!sessionKey || !this.streams.has(sessionKey)) {
      if (stream === 'compaction' || state === 'compacting') {
        const cPhase = str(payloadData?.phase)
        if (isActiveTab || !sessionKey) {
          if (cPhase === 'end') {
            window.setTimeout(() => this.hideBanner(), 2000)
          } else {
            this.showBanner('Compacting context...')
          }
        }
      }
      return
    }

    const ss = this.streams.get(sessionKey)!
    const typingText = this.typingEl.querySelector('.openclaw-typing-text')

    // Agent "assistant" events = agent is actively working
    if (state === 'assistant') {
      const timeSinceDelta = Date.now() - ss.lastDeltaTime
      if (ss.text && timeSinceDelta > 1500) {
        if (!ss.workingTimer) {
          ss.workingTimer = window.setTimeout(() => {
            if (this.streams.has(sessionKey)) {
              if (isActiveTab && this.typingEl.hasClass('oc-hidden')) {
                if (typingText) typingText.textContent = 'Working'
                this.typingEl.removeClass('oc-hidden')
              }
            }
            ss.workingTimer = null
          }, 500)
        }
      } else if (!ss.text && !ss.lastDeltaTime && isActiveTab) {
        this.typingEl.removeClass('oc-hidden')
      }
    } else if (state === 'lifecycle') {
      if (!ss.text && isActiveTab && typingText) {
        typingText.textContent = 'Thinking'
        this.typingEl.removeClass('oc-hidden')
      }
    }

    // Handle explicit tool events
    const toolName = str(
      payloadData?.name,
      str(payloadData?.toolName, str(payload.toolName, str(payload.name)))
    )
    const phase = str(payloadData?.phase, str(payload.phase))

    if (
      (stream === 'tool' || toolName) &&
      (phase === 'start' || state === 'tool_use')
    ) {
      if (ss.compactTimer) {
        window.clearTimeout(ss.compactTimer)
        ss.compactTimer = null
      }
      if (ss.workingTimer) {
        window.clearTimeout(ss.workingTimer)
        ss.workingTimer = null
      }
      if (ss.text) {
        ss.splitPoints.push(ss.text.length)
      }
      const { label, url } = buildToolLabel(
        toolName,
        (payloadData?.args || payload.args) as
          Record<string, unknown> | undefined
      )
      ss.toolCalls.push(label)
      ss.items.push({ type: 'tool', label, url } as StreamItem)
      if (isActiveTab) {
        this.appendToolCall(label, url, true)
        if (typingText) typingText.textContent = label
        this.typingEl.removeClass('oc-hidden')
      }
    } else if ((stream === 'tool' || toolName) && phase === 'result') {
      if (isActiveTab) {
        this.deactivateLastToolItem()
        if (typingText) typingText.textContent = 'Thinking'
        this.typingEl.removeClass('oc-hidden')
        this.scrollToBottom()
      }
    } else if (stream === 'compaction' || state === 'compacting') {
      if (phase === 'end') {
        if (isActiveTab) window.setTimeout(() => this.hideBanner(), 2000)
      } else {
        ss.toolCalls.push('Compacting memory')
        ss.items.push({ type: 'tool', label: 'Compacting memory' })
        if (isActiveTab) {
          this.appendToolCall('Compacting memory')
          this.typingEl.addClass('oc-hidden')
          this.showBanner('Compacting context...')
        }
      }
    }
  }

  handleChatEvent(payload: GatewayPayload): void {
    // Resolve which session this event belongs to
    const payloadSk = str(payload.sessionKey)
    const prefix = this.agentPrefix
    let eventSessionKey: string | null = null
    // Try to match against known sessions
    for (const sk of [...this.streams.keys(), this.activeSessionKey]) {
      if (
        payloadSk === sk ||
        payloadSk === `${prefix}${sk}` ||
        payloadSk.endsWith(`:${sk}`)
      ) {
        eventSessionKey = sk
        break
      }
    }
    // If no stream match, check if it's for the active tab (passive device case)
    if (!eventSessionKey) {
      const active = this.activeSessionKey
      if (
        payloadSk === active ||
        payloadSk === `${prefix}${active}` ||
        payloadSk.endsWith(`:${active}`)
      ) {
        eventSessionKey = active
      } else {
        return // Not for any known session
      }
    }

    const ss = this.streams.get(eventSessionKey)
    const isActiveTab = eventSessionKey === this.activeSessionKey
    const chatState = str(payload.state)

    // No active stream for this session (passive device): still refresh history
    if (
      !ss &&
      (chatState === 'final' ||
        chatState === 'aborted' ||
        chatState === 'error')
    ) {
      if (isActiveTab) {
        this.hideBanner()
        void this.loadHistory()
      }
      return
    }

    if (chatState === 'delta' && ss) {
      if (ss.compactTimer) {
        window.clearTimeout(ss.compactTimer)
        ss.compactTimer = null
      }
      if (ss.workingTimer) {
        window.clearTimeout(ss.workingTimer)
        ss.workingTimer = null
      }
      ss.lastDeltaTime = Date.now()
      const text = this.extractDeltaText(
        payload.message as Record<string, unknown> | string | undefined
      )
      if (text) {
        ss.text = text
        if (isActiveTab) {
          this.typingEl.addClass('oc-hidden')
          this.hideBanner()
          this.updateStreamBubble()
        }
      }
    } else if (chatState === 'final') {
      this.finishStream(eventSessionKey)

      if (isActiveTab) {
        void this.loadHistory().then(async () => {
          await this.renderMessages()
          void this.updateContextMeter()
        })
      }
    } else if (chatState === 'aborted') {
      if (isActiveTab && ss?.text) {
        this.messages.push({
          role: 'assistant',
          text: ss.text,
          images: [],
          timestamp: Date.now(),
        })
      }
      this.finishStream(eventSessionKey)
      if (isActiveTab) void this.renderMessages()
    } else if (chatState === 'error') {
      if (isActiveTab) {
        this.messages.push({
          role: 'assistant',
          text: `Error: ${str(payload.errorMessage, 'unknown error')}`,
          images: [],
          timestamp: Date.now(),
        })
      }
      this.finishStream(eventSessionKey)
      if (isActiveTab) void this.renderMessages()
    }
  }

  private finishStream(sessionKey?: string): void {
    const sk = sessionKey ?? this.activeSessionKey
    const ss = this.streams.get(sk)
    if (ss) {
      if (ss.compactTimer) window.clearTimeout(ss.compactTimer)
      if (ss.workingTimer) window.clearTimeout(ss.workingTimer)
      this.runToSession.delete(ss.runId)
      this.streams.delete(sk)
    }
    // Only clear DOM if this is the active tab
    if (sk === this.activeSessionKey) {
      this.hideBanner()
      this.streamEl = null
      this.abortBtn.addClass('oc-hidden')
      this.typingEl.addClass('oc-hidden')
      const typingText = this.typingEl.querySelector('.openclaw-typing-text')
      if (typingText) typingText.textContent = 'Thinking'
    }
  }

  /** Restore stream UI (typing, tool calls, stream bubble) for the active tab after a tab switch */
  private restoreStreamUI(): void {
    const ss = this.activeStream
    if (!ss) return

    // Show abort button
    this.abortBtn.removeClass('oc-hidden')

    // Restore tool call items in the DOM
    for (const item of ss.items) {
      if (item.type === 'tool') {
        this.appendToolCall(item.label, item.url)
      }
    }

    // Restore stream text bubble if we have delta text
    if (ss.text) {
      this.updateStreamBubble()
      // If text is streaming, show working indicator (text exists but might still be coming)
      const typingText = this.typingEl.querySelector('.openclaw-typing-text')
      if (typingText) typingText.textContent = 'Working'
      this.typingEl.removeClass('oc-hidden')
    } else {
      // No text yet, show thinking
      const typingText = this.typingEl.querySelector('.openclaw-typing-text')
      if (typingText) typingText.textContent = 'Thinking'
      this.typingEl.removeClass('oc-hidden')
    }

    this.scrollToBottom()
  }

  private extractDeltaText(
    msg: Record<string, unknown> | string | undefined
  ): string {
    if (typeof msg === 'string') return msg
    if (!msg) return ''
    // Gateway sends {role, content, timestamp} where content is [{type:"text", text:"..."}]
    const content = msg.content ?? msg
    if (Array.isArray(content)) {
      let text = ''
      for (const block of content) {
        if (typeof block === 'string') {
          text += block
        } else if (block && typeof block === 'object' && 'text' in block) {
          text += (text ? '\n' : '') + String((block as { text: string }).text)
        }
      }
      return text
    }
    if (typeof content === 'string') return content
    return str(msg.text)
  }

  private updateStreamBubble(): void {
    const ss = this.activeStream
    const visibleText = ss?.text
    if (!visibleText) return
    if (!this.streamEl) {
      this.streamEl = this.messagesEl.createDiv(
        'openclaw-msg openclaw-msg-assistant openclaw-streaming markdown-rendered'
      )
      this.scrollToBottom() // Scroll once when bubble first appears
    }
    this.streamEl.empty()
    this.streamEl.createDiv({ text: visibleText, cls: 'openclaw-msg-text' })
    // Don't auto-scroll during text streaming - let user read from the top
  }

  async renderMessages(): Promise<void> {
    this.messagesEl.empty()
    for (const msg of this.messages) {
      if (msg.role === 'assistant') {
        const hasContentTools =
          msg.contentBlocks?.some(
            (b: ContentBlock) => b.type === 'tool_use' || b.type === 'toolCall'
          ) || false

        if (hasContentTools && msg.contentBlocks) {
          // Render interleaved text + tool blocks directly
          for (const block of msg.contentBlocks) {
            if (block.type === 'text' && block.text?.trim()) {
              const cleaned = cleanText(block.text)
              // Render text bubble if there's visible text
              if (cleaned) {
                const bubble = this.messagesEl.createDiv(
                  'openclaw-msg openclaw-msg-assistant markdown-rendered'
                )
                try {
                  await MarkdownRenderer.render(
                    this.app,
                    cleaned,
                    bubble,
                    '',
                    this
                  )
                } catch {
                  bubble.createDiv({ text: cleaned, cls: 'openclaw-msg-text' })
                }
              }
            } else if (block.type === 'tool_use' || block.type === 'toolCall') {
              const { label, url } = buildToolLabel(
                block.name || '',
                block.input || block.arguments || {}
              )
              const el = createStreamItemEl({
                type: 'tool',
                label,
                url,
              } as StreamItem)
              this.messagesEl.appendChild(el)
            }
          }
          continue
        }
      }
      const cls =
        msg.role === 'user'
          ? 'openclaw-msg-user'
          : 'openclaw-msg-assistant markdown-rendered'
      const bubble = this.messagesEl.createDiv(`openclaw-msg ${cls}`)
      // Render images
      if (msg.images && msg.images.length > 0) {
        const imgContainer = bubble.createDiv('openclaw-msg-images')
        for (const src of msg.images) {
          const img = imgContainer.createEl('img', {
            cls: 'openclaw-msg-img',
            attr: { src, loading: 'lazy' },
          })
          img.addEventListener('click', () => {
            // Open full-size in a modal-like overlay
            const overlay = activeDocument.body.createDiv(
              'openclaw-img-overlay'
            )
            overlay.createEl('img', { attr: { src } })
            overlay.addEventListener('click', () => overlay.remove())
          })
        }
      }
      // Render text
      if (msg.text) {
        const displayText =
          msg.role === 'assistant' ? cleanText(msg.text) : msg.text
        if (displayText) {
          if (msg.role === 'assistant') {
            try {
              await MarkdownRenderer.render(
                this.app,
                displayText,
                bubble,
                '',
                this
              )
            } catch {
              bubble.createDiv({ text: displayText, cls: 'openclaw-msg-text' })
            }
          } else {
            this.renderUserText(bubble, displayText)
          }
        }
      }
    }
    this.scrollToBottom()
  }

  private renderUserText(bubble: HTMLElement, text: string): void {
    for (const seg of splitFileBlocks(text)) {
      if (seg.type === 'text') {
        bubble.createDiv({ text: seg.text, cls: 'openclaw-msg-text' })
      } else {
        const details = bubble.createEl('details', {
          cls: 'openclaw-file-attachment',
        })
        details.createEl('summary', {
          cls: 'openclaw-file-summary',
          text: seg.label,
        })
        details
          .createEl('pre', { cls: 'openclaw-file-body' })
          .createEl('code', { text: seg.body })
      }
    }
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      // Use requestAnimationFrame to ensure DOM has updated
      window.requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight
      })
    }
  }

  private autoResize(): void {
    this.inputEl.setCssStyles({ height: 'auto' })
    this.inputEl.setCssStyles({
      height: Math.min(this.inputEl.scrollHeight, 150) + 'px',
    })
  }
}
