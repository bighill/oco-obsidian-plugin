import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  generateId,
  toBase64Url,
  fromBase64Url,
  sha256Hex,
  getOrCreateDeviceIdentity,
  signDevicePayload,
  buildSignaturePayload,
  toArrayBuffer,
} from './crypto'

// ─── generateId ─────────────────────────────────────────────────────

test('generateId returns a 32-char hex string', () => {
  const id = generateId()
  assert.match(id, /^[0-9a-f]{32}$/)
})

test('generateId returns different values', () => {
  const a = generateId()
  const b = generateId()
  assert.notEqual(a, b)
})

// ─── Base64 URL-safe roundtrip ─────────────────────────────────────

test('toBase64Url / fromBase64Url roundtrip', () => {
  const bytes = new Uint8Array([0, 1, 255, 254, 128, 64, 33, 200])
  const encoded = toBase64Url(bytes)
  assert.doesNotMatch(encoded, /[+/=]/)
  const decoded = fromBase64Url(encoded)
  assert.deepEqual(decoded, bytes)
})

// ─── sha256Hex ──────────────────────────────────────────────────────

test('sha256Hex returns a 64-char hex digest', async () => {
  const digest = await sha256Hex(new TextEncoder().encode('hello'))
  assert.match(digest, /^[0-9a-f]{64}$/)
})

// ─── Device identity ───────────────────────────────────────────────

test('getOrCreateDeviceIdentity creates and persists a new identity', async () => {
  const store: Record<string, unknown> = {}
  const identity = await getOrCreateDeviceIdentity(
    async () => ({ ...store }),
    async (data) => {
      Object.assign(store, data)
    }
  )

  assert.equal(typeof identity.deviceId, 'string')
  assert.equal(identity.deviceId.length, 64)
  assert.equal(typeof identity.publicKey, 'string')
  assert.equal(typeof identity.privateKey, 'string')
  assert.equal(store.deviceId, identity.deviceId)
  assert.equal(store.devicePublicKey, identity.publicKey)
  assert.equal(store.devicePrivateKey, identity.privateKey)
})

test('getOrCreateDeviceIdentity restores an existing identity', async () => {
  const store: Record<string, unknown> = {}
  const first = await getOrCreateDeviceIdentity(
    async () => ({ ...store }),
    async (data) => {
      Object.assign(store, data)
    }
  )
  const second = await getOrCreateDeviceIdentity(
    async () => ({ ...store }),
    async (data) => {
      Object.assign(store, data)
    }
  )

  assert.equal(second.deviceId, first.deviceId)
  assert.equal(second.publicKey, first.publicKey)
  assert.equal(second.privateKey, first.privateKey)
})

// ─── Signing and verification ───────────────────────────────────────

test('signDevicePayload produces a verifiable Ed25519 signature', async () => {
  const identity = await getOrCreateDeviceIdentity(
    async () => null,
    async () => undefined
  )

  const payload = buildSignaturePayload({
    deviceId: identity.deviceId,
    clientId: 'gateway-client',
    clientMode: 'ui',
    role: 'operator',
    scopes: ['operator.read'],
    signedAtMs: Date.now(),
    token: 'secret-token',
    nonce: 'server-nonce',
  })

  const signature = await signDevicePayload(identity, payload)
  assert.equal(typeof signature, 'string')

  const pubBytes = fromBase64Url(identity.publicKey)
  const publicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(pubBytes),
    { name: 'Ed25519' },
    false,
    ['verify']
  )

  const ok = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    toArrayBuffer(fromBase64Url(signature)),
    new TextEncoder().encode(payload)
  )
  assert.equal(ok, true)
})

test('buildSignaturePayload uses v1 without nonce and v2 with nonce', () => {
  const v1 = buildSignaturePayload({
    deviceId: 'd1',
    clientId: 'c1',
    clientMode: 'ui',
    role: 'operator',
    scopes: ['operator.read'],
    signedAtMs: 1000,
    token: 't1',
    nonce: null,
  })
  assert.equal(v1, 'v1|d1|c1|ui|operator|operator.read|1000|t1')

  const v2 = buildSignaturePayload({
    deviceId: 'd1',
    clientId: 'c1',
    clientMode: 'ui',
    role: 'operator',
    scopes: ['operator.read'],
    signedAtMs: 1000,
    token: 't1',
    nonce: 'n1',
  })
  assert.equal(v2, 'v2|d1|c1|ui|operator|operator.read|1000|t1|n1')
})
