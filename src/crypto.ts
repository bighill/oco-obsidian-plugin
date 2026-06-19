import type { DeviceIdentity } from './types'

// ─── Base64 URL-safe encoding ──────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function fromBase64Url(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (s.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

// ─── Hashing ─────────────────────────────────────────────────────────

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', toArrayBuffer(data))
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

// ─── ID generation ───────────────────────────────────────────────────

export function generateId(): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Device Identity (Ed25519) ───────────────────────────────────────

export async function getOrCreateDeviceIdentity(
  loadData: () => Promise<Record<string, unknown> | null>,
  saveData: (data: Record<string, unknown>) => Promise<void>
): Promise<DeviceIdentity> {
  const data = await loadData()
  const deviceId = typeof data?.deviceId === 'string' ? data.deviceId : null
  const devicePublicKey =
    typeof data?.devicePublicKey === 'string' ? data.devicePublicKey : null
  const devicePrivateKey =
    typeof data?.devicePrivateKey === 'string' ? data.devicePrivateKey : null
  if (deviceId && devicePublicKey && devicePrivateKey) {
    // Restore existing identity
    const privBytes = fromBase64Url(devicePrivateKey)
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      toArrayBuffer(privBytes),
      { name: 'Ed25519' },
      false,
      ['sign']
    )
    return {
      deviceId,
      publicKey: devicePublicKey,
      privateKey: devicePrivateKey,
      cryptoKey,
    }
  }

  // Generate new Ed25519 keypair
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const pubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey)
  )
  const privPkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  )
  const newDeviceId = await sha256Hex(pubRaw)
  const publicKey = toBase64Url(pubRaw)
  const privateKey = toBase64Url(privPkcs8)

  // Save to plugin data
  const existing = (await loadData()) ?? {}
  existing.deviceId = newDeviceId
  existing.devicePublicKey = publicKey
  existing.devicePrivateKey = privateKey
  await saveData(existing)

  return {
    deviceId: newDeviceId,
    publicKey,
    privateKey,
    cryptoKey: keyPair.privateKey,
  }
}

export async function signDevicePayload(
  identity: DeviceIdentity,
  payload: string
): Promise<string> {
  const encoded = new TextEncoder().encode(payload)
  let cryptoKey = identity.cryptoKey
  // If cryptoKey doesn't have sign usage, re-import
  if (!cryptoKey) {
    const privBytes = fromBase64Url(identity.privateKey)
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      toArrayBuffer(privBytes),
      { name: 'Ed25519' },
      false,
      ['sign']
    )
  }
  const sig = await crypto.subtle.sign('Ed25519', cryptoKey, encoded)
  return toBase64Url(new Uint8Array(sig))
}

export function buildSignaturePayload(params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token: string | null
  nonce: string | null
}): string {
  const version = params.nonce ? 'v2' : 'v1'
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
  ]
  if (version === 'v2') parts.push(params.nonce ?? '')
  return parts.join('|')
}
