import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  GatewayClient,
  normalizeGatewayUrl,
  isLoopbackUrl,
  deleteSessionWithFallback,
} from './gateway-client'

// ─── URL helpers ───────────────────────────────────────────────────

test('normalizeGatewayUrl converts http to ws and https to wss', () => {
  assert.equal(
    normalizeGatewayUrl('http://127.0.0.1:18789'),
    'ws://127.0.0.1:18789'
  )
  assert.equal(normalizeGatewayUrl('https://host:18789'), 'wss://host:18789')
})

test('normalizeGatewayUrl keeps ws/wss and strips trailing slash', () => {
  assert.equal(
    normalizeGatewayUrl('ws://127.0.0.1:18789/'),
    'ws://127.0.0.1:18789'
  )
  assert.equal(
    normalizeGatewayUrl('wss://host:18789/path//'),
    'wss://host:18789/path'
  )
})

test('normalizeGatewayUrl rejects non-ws/http input', () => {
  assert.equal(normalizeGatewayUrl('ftp://host'), null)
  assert.equal(normalizeGatewayUrl('not-a-url'), null)
})

test('isLoopbackUrl identifies loopback addresses', () => {
  assert.equal(isLoopbackUrl('ws://127.0.0.1:18789'), true)
  assert.equal(isLoopbackUrl('wss://localhost:18789'), true)
  assert.equal(isLoopbackUrl('wss://[::1]:18789'), true)
  assert.equal(isLoopbackUrl('wss://192.168.1.1:18789'), false)
})

// ─── deleteSessionWithFallback ─────────────────────────────────────

test('deleteSessionWithFallback returns true on first success', async () => {
  let keyUsed = ''
  const gateway = {
    request: async (_method: string, params: unknown) => {
      keyUsed = (params as { key: string }).key
      return { deleted: true }
    },
  } as GatewayClient

  const ok = await deleteSessionWithFallback(gateway, 'agent:main:tab-1')
  assert.equal(ok, true)
  assert.equal(keyUsed, 'agent:main:tab-1')
})

test('deleteSessionWithFallback retries with raw key when prefixed key fails', async () => {
  const keys: string[] = []
  const gateway = {
    request: async (_method: string, params: unknown) => {
      const key = (params as { key: string }).key
      keys.push(key)
      return { deleted: key === 'tab-1' }
    },
  } as GatewayClient

  const ok = await deleteSessionWithFallback(gateway, 'agent:main:tab-1')
  assert.equal(ok, true)
  assert.deepEqual(keys, ['agent:main:tab-1', 'tab-1'])
})

// ─── GatewayClient WebSocket tests ──────────────────────────────────

class MockWebSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  static instances: MockWebSocket[] = []
  url: string
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  closed = false
  closeCode?: number
  closeReason?: string

  constructor(url: string) {
    super()
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  simulateMessage(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(payload) })
    )
  }
}

let originalWebSocket: typeof WebSocket
let originalWindow: typeof window

before(() => {
  originalWebSocket = globalThis.WebSocket as typeof WebSocket
  originalWindow = globalThis.window
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  // GatewayClient uses window.setTimeout / clearTimeout
  ;(globalThis as unknown as { window: typeof globalThis }).window = globalThis
})

after(() => {
  globalThis.WebSocket = originalWebSocket
  ;(globalThis as unknown as { window: typeof window }).window = originalWindow
})

test('GatewayClient request resolves when a matching response arrives', async () => {
  MockWebSocket.instances.length = 0

  const client = new GatewayClient({
    url: 'ws://127.0.0.1:18789',
    onEvent: () => {},
  })

  client.start()
  const ws = MockWebSocket.instances[0]
  assert.ok(ws)
  ws.simulateOpen()

  const promise = client.request('chat.history', { sessionKey: 'main' })
  const sent = JSON.parse(ws.sent[0])
  assert.equal(sent.type, 'req')
  assert.equal(sent.method, 'chat.history')

  ws.simulateMessage({
    type: 'res',
    id: sent.id,
    ok: true,
    payload: { messages: [] },
  })
  const result = await promise
  assert.deepEqual(result, { messages: [] })

  client.stop()
})

test('GatewayClient request rejects on error response', async () => {
  MockWebSocket.instances.length = 0

  const client = new GatewayClient({ url: 'ws://127.0.0.1:18789' })
  client.start()
  const ws = MockWebSocket.instances[0]
  ws.simulateOpen()

  const promise = client.request('sessions.list', {})
  const sent = JSON.parse(ws.sent[0])
  ws.simulateMessage({
    type: 'res',
    id: sent.id,
    ok: false,
    error: { message: 'not found' },
  })

  await assert.rejects(promise, /not found/)
  client.stop()
})

test('GatewayClient forwards events to onEvent', async () => {
  MockWebSocket.instances.length = 0
  const events: { event: string; payload: Record<string, unknown> }[] = []

  const client = new GatewayClient({
    url: 'ws://127.0.0.1:18789',
    onEvent: (evt) =>
      events.push({
        event: evt.event,
        payload: evt.payload as Record<string, unknown>,
      }),
  })

  client.start()
  const ws = MockWebSocket.instances[0]
  ws.simulateOpen()

  ws.simulateMessage({
    type: 'event',
    event: 'chat',
    payload: { text: 'hi' },
    seq: 1,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'chat')
  assert.equal(events[0].payload.text, 'hi')

  client.stop()
})

test('GatewayClient request throws when not connected', async () => {
  MockWebSocket.instances.length = 0
  const client = new GatewayClient({ url: 'ws://127.0.0.1:18789' })
  await assert.rejects(client.request('chat.history', {}), /not connected/)
})
