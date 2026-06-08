import {
  DEFAULT_CHUNK_SIZE_BYTES,
  decryptJson,
  deriveChunkNonce,
  deriveGroupKeyEncryptionKey,
  encryptAesGcm,
  encryptJson,
  generateFileEncryptionKey,
  randomBytes,
  sha256Base64,
  unwrapFileKey,
  wrapFileKey,
} from './crypto'
import { base64ToBytes, bytesToBase64 } from './base64'
import {
  getPublicSigningKeyJwk,
  signJson,
  verifyJsonSignature,
} from './signing'
import type {
  DecryptedMetadata,
  SignedMediaManifest,
  StoredMediaRecord,
  UnsignedMediaManifest,
  UploadInput,
} from '../types'

export interface DecryptedRecordSummary {
  signatureValid: boolean
  metadata: DecryptedMetadata
}

function buildUnsignedManifest(manifest: SignedMediaManifest): UnsignedMediaManifest {
  const { signatureB64, signerPublicKeyJwk, ...unsigned } = manifest
  void signatureB64
  void signerPublicKeyJwk
  return unsigned
}

export async function encryptAndSignMedia(input: UploadInput): Promise<StoredMediaRecord> {
  if (input.groupPassphrase.trim().length < 8) {
    throw new Error('Group passphrase must be at least 8 characters')
  }

  const mediaId = crypto.randomUUID()
  const kekSalt = randomBytes(16)
  const groupKey = await deriveGroupKeyEncryptionKey(input.groupPassphrase, kekSalt)
  const fileKey = await generateFileEncryptionKey()
  const wrappedFileKeyB64 = await wrapFileKey(fileKey, groupKey)
  const metadata = await encryptJson<DecryptedMetadata>(
    {
      title: input.title,
      caption: input.caption,
      fileName: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      fileSizeBytes: input.file.size,
      uploadedAtIso: new Date().toISOString(),
    },
    fileKey,
  )

  const baseChunkNonce = randomBytes(12)
  const chunks: StoredMediaRecord['chunks'] = []
  const manifestChunks: UnsignedMediaManifest['chunks'] = []
  let chunkIndex = 0

  for (let offset = 0; offset < input.file.size; offset += DEFAULT_CHUNK_SIZE_BYTES) {
    const chunkBlob = input.file.slice(offset, offset + DEFAULT_CHUNK_SIZE_BYTES)
    const chunkBuffer = await chunkBlob.arrayBuffer()
    const plaintextBytes = new Uint8Array(chunkBuffer)
    const nonce = deriveChunkNonce(baseChunkNonce, chunkIndex)
    const ciphertext = await encryptAesGcm(plaintextBytes, fileKey, nonce)
    const objectKey = `media/${mediaId}/chunk-${String(chunkIndex).padStart(5, '0')}.bin`

    chunks.push({
      objectKey,
      ciphertextB64: bytesToBase64(ciphertext),
    })

    manifestChunks.push({
      index: chunkIndex,
      objectKey,
      nonceB64: bytesToBase64(nonce),
      ciphertextSha256B64: await sha256Base64(ciphertext),
      plaintextByteLength: plaintextBytes.byteLength,
    })

    chunkIndex += 1
  }

  const unsignedManifest: UnsignedMediaManifest = {
    schemaVersion: 1,
    mediaId,
    eventId: input.eventId,
    wrappedFileKeyB64,
    kekSaltB64: bytesToBase64(kekSalt),
    algorithm: 'AES-GCM-256',
    chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
    uploadedAtIso: new Date().toISOString(),
    uploaderId: input.uploaderId,
    metadata,
    chunks: manifestChunks,
  }

  const signatureB64 = await signJson(unsignedManifest, input.uploaderId)
  const signerPublicKeyJwk = await getPublicSigningKeyJwk(input.uploaderId)

  return {
    manifest: {
      ...unsignedManifest,
      signatureB64,
      signerPublicKeyJwk,
    },
    chunks,
  }
}

export async function decryptRecordSummary(
  record: StoredMediaRecord,
  groupPassphrase: string,
): Promise<DecryptedRecordSummary> {
  const groupKey = await deriveGroupKeyEncryptionKey(
    groupPassphrase,
    base64ToBytes(record.manifest.kekSaltB64),
  )
  const fileKey = await unwrapFileKey(record.manifest.wrappedFileKeyB64, groupKey)
  const metadata = await decryptJson<DecryptedMetadata>(
    record.manifest.metadata.nonceB64,
    record.manifest.metadata.ciphertextB64,
    fileKey,
  )

  const signatureValid = await verifyJsonSignature(
    buildUnsignedManifest(record.manifest),
    record.manifest.signatureB64,
    record.manifest.signerPublicKeyJwk,
  )

  return {
    signatureValid,
    metadata,
  }
}
