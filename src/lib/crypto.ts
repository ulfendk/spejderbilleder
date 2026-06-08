import { base64ToBytes, bytesToBase64, bytesToString, stringToBytes } from './base64'

const PBKDF2_ITERATIONS = 210_000

export const DEFAULT_CHUNK_SIZE_BYTES = 2 * 1024 * 1024

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export async function deriveGroupKeyEncryptionKey(
  passphrase: string,
  saltBytes: Uint8Array,
): Promise<CryptoKey> {
  const inputKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(stringToBytes(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(saltBytes),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    inputKey,
    {
      name: 'AES-KW',
      length: 256,
    },
    true,
    ['wrapKey', 'unwrapKey'],
  )
}

export async function generateFileEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function wrapFileKey(fileKey: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey('raw', fileKey, wrappingKey, 'AES-KW')
  return bytesToBase64(new Uint8Array(wrapped))
}

export async function unwrapFileKey(
  wrappedFileKeyB64: string,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    toArrayBuffer(base64ToBytes(wrappedFileKeyB64)),
    wrappingKey,
    'AES-KW',
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  )
}

export function deriveChunkNonce(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
  const nonce = new Uint8Array(baseNonce)
  const dataView = new DataView(nonce.buffer)
  dataView.setUint32(nonce.byteLength - 4, chunkIndex, false)
  return nonce
}

export async function encryptAesGcm(
  plaintext: Uint8Array,
  key: CryptoKey,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
    },
    key,
    toArrayBuffer(plaintext),
  )

  return new Uint8Array(ciphertext)
}

export async function decryptAesGcm(
  ciphertext: Uint8Array,
  key: CryptoKey,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
    },
    key,
    toArrayBuffer(ciphertext),
  )

  return new Uint8Array(plaintext)
}

export async function sha256Base64(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(payload))
  return bytesToBase64(new Uint8Array(digest))
}

export async function encryptJson<TPayload extends object>(
  payload: TPayload,
  key: CryptoKey,
): Promise<{ nonceB64: string; ciphertextB64: string }> {
  const nonce = randomBytes(12)
  const plaintext = stringToBytes(JSON.stringify(payload))
  const ciphertext = await encryptAesGcm(plaintext, key, nonce)

  return {
    nonceB64: bytesToBase64(nonce),
    ciphertextB64: bytesToBase64(ciphertext),
  }
}

export async function decryptJson<TPayload extends object>(
  nonceB64: string,
  ciphertextB64: string,
  key: CryptoKey,
): Promise<TPayload> {
  const plaintext = await decryptAesGcm(base64ToBytes(ciphertextB64), key, base64ToBytes(nonceB64))
  return JSON.parse(bytesToString(plaintext)) as TPayload
}
