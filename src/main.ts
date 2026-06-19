import { Modal, Notice, Plugin } from 'obsidian'
import { GatewayClient, normalizeGatewayUrl } from './gateway-client'
import { getOrCreateDeviceIdentity } from './crypto'
import { OpenClawChatView, VIEW_TYPE } from './chat-view'
import { OpenClawSettingTab } from './settings-tab'
import type { OpenClawSettings, DeviceIdentity } from './types'

// ─── Settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: OpenClawSettings = {
  gatewayUrl: '',
  token: '',
  sessionKey: 'main',
}

// ─── Welcome Modal ─────────────────────────────────────────────────────

class WelcomeModal extends Modal {
  onOpen(): void {
    this.contentEl.createEl('h2', { text: 'Welcome to OcO' })
    this.contentEl.createEl('p', {
      text: "This plugin connects Obsidian to your OpenClaw AI agent. Your vault becomes the agent's workspace.",
      cls: 'openclaw-onboard-desc',
    })
    this.contentEl.createEl('p', {
      text: 'Go to Settings → OcO → Connection to enter your gateway URL and token.',
      cls: 'openclaw-onboard-desc',
    })
    const btnRow = this.contentEl.createDiv('openclaw-onboard-buttons')
    btnRow.createEl('button', {
      text: 'Got it',
      cls: 'mod-cta',
    }).addEventListener('click', () => this.close())
  }
}

// ─── Main Plugin ─────────────────────────────────────────────────────

export default class OpenClawPlugin extends Plugin {
  settings: OpenClawSettings = DEFAULT_SETTINGS
  gateway: GatewayClient | null = null
  gatewayConnected = false
  lastGatewayConnectError = ''
  chatView: OpenClawChatView | null = null
  // Consecutive close events with no successful hello in between.
  // After a few in a row, we surface the patch hint - a likely sign the
  // gateway is rejecting our origin during the websocket handshake.
  private handshakeFailuresInARow = 0
  private patchHintShownThisSession = false

  async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(VIEW_TYPE, (leaf) => new OpenClawChatView(leaf, this))

    // Ribbon icon
    this.addRibbonIcon('message-square', 'OcO chat', () => {
      void this.activateView()
    })

    // Commands
    this.addCommand({
      id: 'toggle-chat',
      name: 'Toggle chat sidebar',
      callback: () => void this.activateView(),
    })

    this.addCommand({
      id: 'ask-about-note',
      name: 'Ask about current note',
      callback: () => void this.askAboutNote(),
    })

    this.addCommand({
      id: 'reconnect',
      name: 'Reconnect to gateway',
      callback: () => void this.connectGateway(),
    })

    this.addSettingTab(new OpenClawSettingTab(this.app, this))

    // Show welcome on first run, otherwise auto-connect and open chat
    if (!this.settings.gatewayUrl) {
      window.setTimeout(() => new WelcomeModal(this.app).open(), 500)
    } else {
      void this.connectGateway()
      this.app.workspace.onLayoutReady(() => {
        void this.activateView()
      })
    }
  }

  onunload(): void {
    this.gateway?.stop()
    this.gateway = null
    this.gatewayConnected = false
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<OpenClawSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {})
  }

  getCloseConfirmDisabled(): boolean {
    return this.settings.confirmCloseDisabled === true
  }

  setCloseConfirmDisabled(disabled: boolean): void {
    this.settings.confirmCloseDisabled = disabled
    void this.saveSettings()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async connectGateway(): Promise<void> {
    this.gateway?.stop()
    this.gatewayConnected = false
    this.lastGatewayConnectError = ''
    this.chatView?.updateStatus()

    const rawUrl = this.settings.gatewayUrl.trim()
    if (!rawUrl) return

    // Normalize URL (accept https:// and http:// as well)
    const url = normalizeGatewayUrl(rawUrl)
    if (!url) {
      new Notice(
        'OcO: Invalid gateway URL. Use ws://127.0.0.1:18789 (or your custom address).'
      )
      return
    }

    // Persist the normalized form if it changed
    if (url !== rawUrl) {
      this.settings.gatewayUrl = url
      await this.saveSettings()
    }

    // Get or create device identity for scope authorization
    let deviceIdentity: DeviceIdentity | undefined
    try {
      deviceIdentity = await getOrCreateDeviceIdentity(
        () => this.loadData(),
        (data) => this.saveData(data)
      )
    } catch (e) {
      console.warn(
        '[OcO] Device identity creation failed, connecting without scopes:',
        e
      )
    }

    this.gateway = new GatewayClient({
      url,
      token: this.settings.token.trim() || undefined,
      deviceIdentity,
      onHello: () => {
        this.gatewayConnected = true
        this.lastGatewayConnectError = ''
        this.handshakeFailuresInARow = 0
        this.chatView?.updateStatus()
        this.chatView?.hidePairingBanner() // Dismiss pairing banner on successful connection
        void this.chatView?.loadHistory()
        void this.chatView?.renderTabs()
        void this.chatView?.loadAgents()
        void this.chatView?.loadDefaults()
        // Restore persisted model selection
        if (this.settings.currentModel && this.chatView) {
          this.chatView.currentModel = this.settings.currentModel
          this.chatView.updateModelPill()
        }
      },
      onClose: (info) => {
        const wasConnected = this.gatewayConnected
        this.gatewayConnected = false
        this.chatView?.updateStatus()
        // Show pairing banner if needed
        const reason = info.reason.toLowerCase()
        if (
          reason.includes('pair') ||
          reason.includes('device') ||
          reason.includes('approval') ||
          reason.includes('scope') ||
          reason.includes('auth')
        ) {
          this.chatView?.showPairingBanner()
        }
        // Track handshake-only failures (closed without ever reaching onHello).
        // 3+ in a row with no descriptive reason is a strong hint the gateway
        // rejected our origin at the websocket upgrade - show the patch tip once.
        if (!wasConnected) {
          this.handshakeFailuresInARow += 1
          const lacksReason = !info.reason || info.reason.trim() === ''
          if (
            this.handshakeFailuresInARow >= 3 &&
            lacksReason &&
            !this.patchHintShownThisSession
          ) {
            this.patchHintShownThisSession = true
            new Notice(
              'OcO: handshake keeps failing. Apply the origin patch (see README) or check Settings → OcO → Connection.',
              12000
            )
          }
        }
      },
      onConnectError: (message) => {
        this.lastGatewayConnectError = message
      },
      onEvent: (evt) => {
        if (evt.event === 'chat') {
          this.chatView?.handleChatEvent(evt.payload)
        } else if (evt.event === 'stream' || evt.event === 'agent') {
          this.chatView?.handleStreamEvent(evt.payload)
        }
      },
    })

    this.gateway.start()
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
    if (existing.length > 0) {
      this.app.workspace.setActiveLeaf(existing[0], { focus: true })
      return
    }
    const leaf = this.app.workspace.getRightLeaf(false)
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true })
      this.app.workspace.setActiveLeaf(leaf, { focus: true })
    }
  }

  async askAboutNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile()
    if (!file) {
      new Notice('No active note')
      return
    }

    const content = await this.app.vault.read(file)
    if (!content.trim()) {
      new Notice('Note is empty')
      return
    }

    await this.activateView()

    if (!this.chatView || !this.gateway?.connected) {
      new Notice('Not connected to OcO')
      return
    }

    const message = `Here is my current note "${file.basename}":\n\n${content}\n\nWhat can you tell me about this?`
    const inputEl = this.chatView.containerEl.querySelector(
      '.openclaw-input'
    ) as HTMLTextAreaElement
    if (inputEl) {
      inputEl.value = message
      inputEl.focus()
    }
  }
}
