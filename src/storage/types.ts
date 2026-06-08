import type { StorageBackendKind, StoredMediaRecord } from '../types'

export interface MediaStorageAdapter {
  readonly kind: StorageBackendKind
  save(record: StoredMediaRecord): Promise<void>
  list(): Promise<StoredMediaRecord[]>
}
