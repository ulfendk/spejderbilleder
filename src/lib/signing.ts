import { base64ToBytes, bytesToBase64, stringToBytes } from './base64'

const PRIVATE_KEY_PREFIX = 'spejderbilleder:signing-private:'
const PUBLIC_KEY_PREFIX = 'spejderbilleder:signing-public:'

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry))
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((sorted, [key, nested]) => {
        sorted[key] = canonicalize(nested)
        return sorted
      }, {})
  }

  return value
}

async function loadOrCreateSigningPrivateKey(signerId: string): Promise<CryptoKey> {
  const privateKeyJson = localStorage.getItem(`${PRIVATE_KEY_PREFIX}${signerId}`)
  const publicKeyJson = localStorage.getItem(`${PUBLIC_KEY_PREFIX}${signerId}`)

  if (privateKeyJson !== null && publicKeyJson !== null) {
    return crypto.subtle.importKey(
      'jwk',
      JSON.parse(privateKeyJson) as JsonWebKey,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['sign'],
    )
  }

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  )

  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

  localStorage.setItem(`${PRIVATE_KEY_PREFIX}${signerId}`, JSON.stringify(privateJwk))
  localStorage.setItem(`${PUBLIC_KEY_PREFIX}${signerId}`, JSON.stringify(publicJwk))

  return keyPair.privateKey
}

export async function getPublicSigningKeyJwk(signerId: string): Promise<JsonWebKey> {
  const existing = localStorage.getItem(`${PUBLIC_KEY_PREFIX}${signerId}`)
  if (existing !== null) {
    return JSON.parse(existing) as JsonWebKey
  }

  await loadOrCreateSigningPrivateKey(signerId)
  const created = localStorage.getItem(`${PUBLIC_KEY_PREFIX}${signerId}`)

  if (created === null) {
    throw new Error('Kunne ikke gemme offentlig signeringsnøgle.')
  }

  return JSON.parse(created) as JsonWebKey
}

export async function signJson(payload: unknown, signerId: string): Promise<string> {
  const privateKey = await loadOrCreateSigningPrivateKey(signerId)
  const canonicalPayload = JSON.stringify(canonicalize(payload))
  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    privateKey,
    toArrayBuffer(stringToBytes(canonicalPayload)),
  )

  return bytesToBase64(new Uint8Array(signature))
}

export async function verifyJsonSignature(
  payload: unknown,
  signatureB64: string,
  publicKeyJwk: JsonWebKey,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['verify'],
  )

  const canonicalPayload = JSON.stringify(canonicalize(payload))
  return crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    publicKey,
    toArrayBuffer(base64ToBytes(signatureB64)),
    toArrayBuffer(stringToBytes(canonicalPayload)),
  )
}
