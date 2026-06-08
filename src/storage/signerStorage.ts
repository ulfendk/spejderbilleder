import type { StoredMediaRecord } from '../types'
import type { MediaStorageAdapter } from './types'

interface SignerApiListResponse {
  records: StoredMediaRecord[]
}

export class SignerStorageAdapter implements MediaStorageAdapter {
  readonly kind = 's3-signer' as const

  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async save(record: StoredMediaRecord): Promise<void> {
    const response = await fetch(`${this.baseUrl}/media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(record),
    })

    if (!response.ok) {
      throw new Error(`Signer backend rejected upload (${response.status})`)
    }
  }

  async list(): Promise<StoredMediaRecord[]> {
    const response = await fetch(`${this.baseUrl}/media`, {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(`Signer backend failed to list media (${response.status})`)
    }

    const body = (await response.json()) as SignerApiListResponse
    return body.records
  }
}
