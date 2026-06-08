import type { SignedMediaManifest } from '../types'

const DB_NAME = 'spejderbilleder-gallery-index'
const DB_VERSION = 1
const STORE_NAME = 'entries'
const INDEX_SCHEMA_VERSION = 1

export interface GalleryIndexEntry {
  key: string
  schemaVersion: number
  mediaId: string
  uploadedAtIso: string
  captureAtIso?: string
  title: string
  caption: string
  fileName: string
  mimeType: string
  fileSizeBytes: number
  locationLabel?: string
  locationLat?: number
  locationLng?: number
  tags: string[]
  signatureValid: boolean
}

function openIndexDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => {
      reject(new Error('Kunne ikke åbne galleriindeks-databasen.'))
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
  })
}

export function buildGalleryIndexKey(
  manifest: SignedMediaManifest,
  passphraseFingerprint: string,
): string {
  return [
    INDEX_SCHEMA_VERSION,
    manifest.schemaVersion,
    manifest.mediaId,
    manifest.signatureB64,
    passphraseFingerprint,
  ].join(':')
}

export async function getGalleryIndexEntry(key: string): Promise<GalleryIndexEntry | undefined> {
  const db = await openIndexDb()
  try {
    return await new Promise<GalleryIndexEntry | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)
      request.onerror = () => {
        reject(new Error('Kunne ikke læse fra galleriindeks-cachen.'))
      }
      request.onsuccess = () => {
        const entry = request.result as GalleryIndexEntry | undefined
        if (!entry || entry.schemaVersion !== INDEX_SCHEMA_VERSION) {
          resolve(undefined)
          return
        }
        resolve(entry)
      }
    })
  } finally {
    db.close()
  }
}

export async function putGalleryIndexEntry(entry: GalleryIndexEntry): Promise<void> {
  const db = await openIndexDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put({
        ...entry,
        schemaVersion: INDEX_SCHEMA_VERSION,
      } satisfies GalleryIndexEntry)
      request.onerror = () => {
        reject(new Error('Kunne ikke skrive cachepost i galleriindekset.'))
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        reject(new Error('Kunne ikke fuldføre skrivning til galleriindeks-cachen.'))
      }
    })
  } finally {
    db.close()
  }
}

export async function clearGalleryIndex(): Promise<void> {
  const db = await openIndexDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()
      request.onerror = () => {
        reject(new Error('Kunne ikke rydde galleriindeks-cachen.'))
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        reject(new Error('Kunne ikke fuldføre rydning af galleriindeks-cachen.'))
      }
    })
  } finally {
    db.close()
  }
}
