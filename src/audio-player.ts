/** Helpers for rendering gateway voice message audio players in the chat UI. */

/** Remove TTS/audio directives and refs that are rendered as audio players. */
export function cleanText(text: string): string {
  text = text.replace(/^\[\[audio_as_voice\]\]\s*/gm, '').trim()
  text = text.replace(/^MEDIA:.*$/gm, '').trim()
  text = text.replace(/^VOICE:[^\s\n]+$/gm, '').trim()
  text = text.replace(/^AUDIO_DATA:.*$/gm, '').trim()
  if (text === '🎤 Voice message') text = '🎤 Voice message' // keep the label
  if (text === 'NO_REPLY' || text === 'HEARTBEAT_OK') return ''
  return text
}

/** Extract VOICE:path references from message text. */
export function extractVoiceRefs(text: string): string[] {
  const refs: string[] = []
  const re = /^VOICE:([^\s\n]+\.(?:mp3|opus|ogg|wav|m4a|mp4))$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    refs.push(match[1].trim())
  }
  return refs
}

/** Build HTTP URL for a voice file served by the gateway. */
export function buildVoiceUrl(gatewayUrl: string, voicePath: string): string {
  const httpUrl = gatewayUrl
    .replace(/^ws(s?):\/\//, 'http$1://')
    .replace(/\/$/, '')
  const path = voicePath.startsWith('/') ? voicePath.slice(1) : voicePath
  return `${httpUrl}/${path}`
}

/** Render an inline audio player that fetches audio via gateway HTTP. */
export function renderAudioPlayer(
  container: HTMLElement,
  voiceRef: string,
  gatewayUrl: string
): void {
  const playerEl = container.createDiv('openclaw-audio-player')
  const playBtn = playerEl.createEl('button', {
    cls: 'openclaw-audio-play-btn',
    text: '▶ voice message',
  })
  const progressEl = playerEl.createDiv('openclaw-audio-progress')
  const barEl = progressEl.createDiv('openclaw-audio-bar')

  let audio: HTMLAudioElement | null = null

  playBtn.addEventListener(
    'click',
    () =>
      void (async () => {
        if (audio && !audio.paused) {
          audio.pause()
          playBtn.textContent = '▶ voice message'
          return
        }

        if (!audio) {
          playBtn.textContent = '⏳ loading...'
          try {
            const url = buildVoiceUrl(gatewayUrl, voiceRef)
            console.debug('[OcO] Loading audio from:', url)
            audio = new Audio(url)

            await new Promise<void>((resolve, reject) => {
              const timer = window.setTimeout(
                () => reject(new Error('timeout')),
                10000
              )
              audio!.addEventListener(
                'canplaythrough',
                () => {
                  window.clearTimeout(timer)
                  resolve()
                },
                { once: true }
              )
              audio!.addEventListener(
                'error',
                () => {
                  window.clearTimeout(timer)
                  reject(new Error('load error'))
                },
                { once: true }
              )
              audio!.load()
            })

            audio.addEventListener('timeupdate', () => {
              if (audio && audio.duration)
                barEl.setCssStyles({
                  width: `${(audio.currentTime / audio.duration) * 100}%`,
                })
            })
            audio.addEventListener('ended', () => {
              playBtn.textContent = '▶ voice message'
              barEl.setCssStyles({ width: '0%' })
            })
          } catch (e) {
            console.error('[OcO] Audio load failed:', e)
            playBtn.textContent = '⚠ audio unavailable'
            playBtn.disabled = true
            return
          }
        }

        playBtn.textContent = '⏸ playing...'
        audio.play().catch(() => {
          playBtn.textContent = '⚠ audio unavailable'
          playBtn.disabled = true
        })
      })()
  )
}
