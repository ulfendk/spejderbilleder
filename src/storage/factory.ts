import type { MediaStorageAdapter } from './types'
import { MockStorageAdapter } from './mockStorage'
import { SignerStorageAdapter } from './signerStorage'
import type { StorageBackendKind } from '../types'

const BACKEND_MAP: Record<StorageBackendKind, () => MediaStorageAdapter> = {
  mock: () => new MockStorageAdapter(),
  's3-signer': () => new SignerStorageAdapter(import.meta.env.VITE_SIGNER_API_BASE ?? '/api'),
}

export function createStorageAdapter(backend: StorageBackendKind): MediaStorageAdapter {
  return BACKEND_MAP[backend]()
}

export function readConfiguredBackend(): StorageBackendKind {
  const configured = import.meta.env.VITE_STORAGE_BACKEND ?? 'mock'

  if (configured === 'mock' || configured === 's3-signer') {
    return configured
  }

  throw new Error(
    `Unsupported VITE_STORAGE_BACKEND value: "${configured}". Use "mock" or "s3-signer".`,
  )
}
