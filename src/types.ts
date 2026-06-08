export type UserRole = 'leader' | 'parent'

export type StorageBackendKind = 'mock' | 's3-signer'

export interface EncryptedChunk {
  index: number
  objectKey: string
  nonceB64: string
  ciphertextB64: string
  ciphertextSha256B64: string
  plaintextByteLength: number
}

export interface EncryptedMetadataEnvelope {
  nonceB64: string
  ciphertextB64: string
}

export interface UnsignedMediaManifest {
  schemaVersion: 1
  mediaId: string
  eventId: string
  wrappedFileKeyB64: string
  kekSaltB64: string
  algorithm: 'AES-GCM-256'
  chunkSizeBytes: number
  uploadedAtIso: string
  uploaderId: string
  metadata: EncryptedMetadataEnvelope
  chunks: Array<{
    index: number
    objectKey: string
    nonceB64: string
    ciphertextSha256B64: string
    plaintextByteLength: number
  }>
}

export interface SignedMediaManifest extends UnsignedMediaManifest {
  signatureB64: string
  signerPublicKeyJwk: JsonWebKey
}

export interface StoredMediaRecord {
  manifest: SignedMediaManifest
  chunks: Array<{
    objectKey: string
    ciphertextB64: string
  }>
}

export interface DecryptedMetadata {
  title: string
  caption: string
  fileName: string
  mimeType: string
  fileSizeBytes: number
  uploadedAtIso: string
  captureAtIso?: string
  locationLabel?: string
  locationLat?: number
  locationLng?: number
  tags?: string[]
}

export interface UploadInput {
  file: File
  eventId: string
  title: string
  caption: string
  uploaderId: string
  groupPassphrase: string
  captureAtIso?: string
  locationLabel?: string
  locationLat?: number
  locationLng?: number
  tags?: string[]
}
