import type { StoredMediaRecord } from '../types'
import type { MediaStorageAdapter } from './types'

const STORAGE_KEY = 'spejderbilleder:mock-storage:v1'

function parseRecords(jsonValue: string): StoredMediaRecord[] {
  const parsed = JSON.parse(jsonValue) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid mock storage state: expected array')
  }

  return parsed as StoredMediaRecord[]
}

export class MockStorageAdapter implements MediaStorageAdapter {
  readonly kind = 'mock' as const

  async save(record: StoredMediaRecord): Promise<void> {
    const records = await this.list()
    records.push(record)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  }

  async list(): Promise<StoredMediaRecord[]> {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return []
    }

    return parseRecords(raw)
  }
}
