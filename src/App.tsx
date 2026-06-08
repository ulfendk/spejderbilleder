import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import exifr from 'exifr'
import './App.css'
import type { GalleryIndexEntry } from './lib/galleryIndex'
import {
  buildGalleryIndexKey,
  clearGalleryIndex,
  getGalleryIndexEntry,
  putGalleryIndexEntry,
} from './lib/galleryIndex'
import { decryptRecordMedia, decryptRecordSummary, encryptAndSignMedia } from './lib/media'
import { createStorageAdapter, readConfiguredBackend } from './storage/factory'
import type { StoredMediaRecord, UserRole } from './types'

interface GalleryItem {
  mediaId: string
  eventId: string
  uploaderId: string
  uploadedAtIso: string
  title?: string
  caption?: string
  fileName?: string
  mimeType?: string
  fileSizeBytes?: number
  signatureValid?: boolean
  captureAtIso?: string
  locationLabel?: string
  tags: string[]
  lockedReason?: string
}

interface IndexingProgress {
  processed: number
  total: number
}

type SortOption =
  | 'uploaded-desc'
  | 'uploaded-asc'
  | 'captured-desc'
  | 'captured-asc'
  | 'title-asc'
  | 'location-asc'

interface ParsedExif {
  DateTimeOriginal?: Date
  CreateDate?: Date
  latitude?: number
  longitude?: number
}

const configuredBackend = readConfiguredBackend()
const storageAdapter = createStorageAdapter(configuredBackend)
const INDEX_BATCH_SIZE = 25
const INITIAL_VISIBLE_COUNT = 80
const VISIBLE_INCREMENT = 80

function normalizeEventId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const date = new Date().toISOString().slice(0, 10)
  return `${slug || 'event'}-${date}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function backendNotice(): string {
  if (configuredBackend === 'mock') {
    return 'Demo mode: encrypted records are saved in browser localStorage only.'
  }
  return 'Signer mode: app expects a private backend at VITE_SIGNER_API_BASE for authenticated presigned storage access.'
}

function sortNewestFirst(records: StoredMediaRecord[]): StoredMediaRecord[] {
  return [...records].sort((left, right) =>
    right.manifest.uploadedAtIso.localeCompare(left.manifest.uploadedAtIso),
  )
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  )
}

function parseTagsInput(value: string): string[] {
  return normalizeTags(value.split(','))
}

function toDateTimeLocalInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function parseCoordinate(value: string, label: string, min: number, max: number): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`)
  }
  return parsed
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

async function fingerprintPassphrase(passphrase: string): Promise<string> {
  const encoded = new TextEncoder().encode(passphrase)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function preferredTimestamp(item: GalleryItem): string {
  return item.captureAtIso ?? item.uploadedAtIso
}

function buildLockedItem(record: StoredMediaRecord, reason: string): GalleryItem {
  return {
    mediaId: record.manifest.mediaId,
    eventId: record.manifest.eventId,
    uploaderId: record.manifest.uploaderId,
    uploadedAtIso: record.manifest.uploadedAtIso,
    tags: [],
    lockedReason: reason,
  }
}

function toGalleryItem(record: StoredMediaRecord, entry: GalleryIndexEntry): GalleryItem {
  return {
    mediaId: record.manifest.mediaId,
    eventId: record.manifest.eventId,
    uploaderId: record.manifest.uploaderId,
    uploadedAtIso: record.manifest.uploadedAtIso,
    title: entry.title,
    caption: entry.caption,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    fileSizeBytes: entry.fileSizeBytes,
    signatureValid: entry.signatureValid,
    captureAtIso: entry.captureAtIso,
    locationLabel: entry.locationLabel,
    tags: entry.tags,
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<'feed' | 'upload'>('feed')
  const [records, setRecords] = useState<StoredMediaRecord[]>([])
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([])
  const [indexingProgress, setIndexingProgress] = useState<IndexingProgress | null>(null)

  const [role, setRole] = useState<UserRole>('leader')
  const [uploaderId, setUploaderId] = useState('leader-lars')
  const [eventTitle, setEventTitle] = useState('Monday campfire')
  const [title, setTitle] = useState('Campfire songs at sunset')
  const [caption, setCaption] = useState('The wolves practiced guitar and sang together.')
  const [passphrase, setPassphrase] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [captureAtInput, setCaptureAtInput] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [locationLatInput, setLocationLatInput] = useState('')
  const [locationLngInput, setLocationLngInput] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [feedback, setFeedback] = useState<string>('')
  const [fileInputResetKey, setFileInputResetKey] = useState(0)

  const [sortOption, setSortOption] = useState<SortOption>('captured-desc')
  const [locationFilter, setLocationFilter] = useState('')
  const [tagsFilter, setTagsFilter] = useState('')
  const [fromDateFilter, setFromDateFilter] = useState('')
  const [toDateFilter, setToDateFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({})
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({})

  const previewUrlMapRef = useRef<Map<string, string>>(new Map())
  const previewLoadingSetRef = useRef<Set<string>>(new Set())
  const previewErrorMapRef = useRef<Map<string, string>>(new Map())

  const recordByMediaId = useMemo(
    () => new Map(records.map((record) => [record.manifest.mediaId, record])),
    [records],
  )

  const activeTagFilters = useMemo(() => parseTagsInput(tagsFilter), [tagsFilter])

  const availableTags = useMemo(() => {
    const allTags = galleryItems.flatMap((item) => item.tags)
    return Array.from(new Set(allTags)).sort((left, right) => left.localeCompare(right))
  }, [galleryItems])

  const revokePreviewUrls = useCallback(() => {
    for (const url of previewUrlMapRef.current.values()) {
      URL.revokeObjectURL(url)
    }
    previewUrlMapRef.current.clear()
  }, [])

  const resetPreviewState = useCallback(() => {
    revokePreviewUrls()
    previewLoadingSetRef.current.clear()
    previewErrorMapRef.current.clear()
    setPreviewUrls({})
    setPreviewLoading({})
    setPreviewErrors({})
  }, [revokePreviewUrls])

  async function refreshRecords(): Promise<void> {
    const listed = await storageAdapter.list()
    resetPreviewState()
    setRecords(sortNewestFirst(listed))
  }

  const loadPreview = useCallback(
    async (mediaId: string): Promise<void> => {
      if (previewUrlMapRef.current.has(mediaId) || previewLoadingSetRef.current.has(mediaId)) {
        return
      }

      const record = recordByMediaId.get(mediaId)
      if (!record) {
        return
      }

      const trimmedPassphrase = passphrase.trim()
      if (trimmedPassphrase.length < 8) {
        return
      }

      previewLoadingSetRef.current.add(mediaId)
      setPreviewLoading((current) => ({ ...current, [mediaId]: true }))
      previewErrorMapRef.current.delete(mediaId)
      setPreviewErrors((current) => {
        const next = { ...current }
        delete next[mediaId]
        return next
      })

      try {
        const media = await decryptRecordMedia(record, trimmedPassphrase)
        if (!media.blob) {
          throw new Error('Preview is currently available for image files only.')
        }
        const objectUrl = URL.createObjectURL(media.blob)
        const previous = previewUrlMapRef.current.get(mediaId)
        if (previous) {
          URL.revokeObjectURL(previous)
        }
        previewUrlMapRef.current.set(mediaId, objectUrl)
        setPreviewUrls((current) => ({ ...current, [mediaId]: objectUrl }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load preview.'
        previewErrorMapRef.current.set(mediaId, message)
        setPreviewErrors((current) => ({ ...current, [mediaId]: message }))
      } finally {
        previewLoadingSetRef.current.delete(mediaId)
        setPreviewLoading((current) => {
          const next = { ...current }
          delete next[mediaId]
          return next
        })
      }
    },
    [passphrase, recordByMediaId],
  )

  useEffect(() => {
    let cancelled = false

    void storageAdapter
      .list()
      .then((listed) => {
        if (!cancelled) {
          resetPreviewState()
          setRecords(sortNewestFirst(listed))
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFeedback(error instanceof Error ? error.message : 'Failed to load records.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [resetPreviewState])

  useEffect(() => {
    return () => {
      revokePreviewUrls()
    }
  }, [revokePreviewUrls])

  useEffect(() => {
    let cancelled = false

    async function rebuildGalleryItems(): Promise<void> {
      const sortedRecords = sortNewestFirst(records)
      if (sortedRecords.length === 0) {
        setGalleryItems([])
        setIndexingProgress(null)
        return
      }

      const trimmedPassphrase = passphrase.trim()
      if (trimmedPassphrase.length < 8) {
        setGalleryItems(
          sortedRecords.map((record) =>
            buildLockedItem(record, 'Enter group passphrase (min. 8 chars) to unlock metadata.'),
          ),
        )
        setIndexingProgress(null)
        return
      }

      setIndexingProgress({ processed: 0, total: sortedRecords.length })
      const passphraseFingerprint = await fingerprintPassphrase(trimmedPassphrase)
      const nextItems: GalleryItem[] = []
      let processed = 0

      for (const record of sortedRecords) {
        if (cancelled) {
          return
        }

        const cacheKey = buildGalleryIndexKey(record.manifest, passphraseFingerprint)
        try {
          const cached = await getGalleryIndexEntry(cacheKey)
          if (cached) {
            nextItems.push(toGalleryItem(record, cached))
          } else {
            const summary = await decryptRecordSummary(record, trimmedPassphrase)
            const entry: GalleryIndexEntry = {
              key: cacheKey,
              schemaVersion: 1,
              mediaId: record.manifest.mediaId,
              uploadedAtIso: record.manifest.uploadedAtIso,
              captureAtIso: summary.metadata.captureAtIso,
              title: summary.metadata.title,
              caption: summary.metadata.caption,
              fileName: summary.metadata.fileName,
              mimeType: summary.metadata.mimeType,
              fileSizeBytes: summary.metadata.fileSizeBytes,
              locationLabel: summary.metadata.locationLabel,
              tags: normalizeTags(summary.metadata.tags ?? []),
              signatureValid: summary.signatureValid,
            }
            await putGalleryIndexEntry(entry)
            nextItems.push(toGalleryItem(record, entry))
          }
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : 'Could not decrypt with this passphrase.'
          nextItems.push(buildLockedItem(record, reason))
        }

        processed += 1
        if (processed % INDEX_BATCH_SIZE === 0 || processed === sortedRecords.length) {
          setGalleryItems([...nextItems])
          setIndexingProgress({ processed, total: sortedRecords.length })
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0)
          })
        }
      }

      if (!cancelled) {
        setGalleryItems(nextItems)
        setIndexingProgress(null)
      }
    }

    void rebuildGalleryItems().catch((error: unknown) => {
      if (!cancelled) {
        setFeedback(error instanceof Error ? error.message : 'Failed to build gallery index.')
        setIndexingProgress(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [records, passphrase])

  const filteredAndSortedItems = useMemo(() => {
    const hasMetadataFilter =
      fromDateFilter.length > 0 ||
      toDateFilter.length > 0 ||
      locationFilter.trim().length > 0 ||
      activeTagFilters.length > 0
    const locationNeedle = locationFilter.trim().toLowerCase()
    const fromIso = fromDateFilter ? new Date(fromDateFilter).toISOString() : undefined
    const toIso = toDateFilter ? new Date(toDateFilter).toISOString() : undefined

    const filtered = galleryItems.filter((item) => {
      if (item.lockedReason) {
        return !hasMetadataFilter
      }

      const timestamp = preferredTimestamp(item)
      if (fromIso && timestamp < fromIso) {
        return false
      }
      if (toIso && timestamp > toIso) {
        return false
      }

      if (locationNeedle && !(item.locationLabel ?? '').toLowerCase().includes(locationNeedle)) {
        return false
      }

      if (activeTagFilters.length > 0) {
        const tagSet = new Set(item.tags.map((tag) => tag.toLowerCase()))
        if (!activeTagFilters.every((tag) => tagSet.has(tag))) {
          return false
        }
      }

      return true
    })

    return filtered.sort((left, right) => {
      switch (sortOption) {
        case 'uploaded-asc':
          return left.uploadedAtIso.localeCompare(right.uploadedAtIso)
        case 'uploaded-desc':
          return right.uploadedAtIso.localeCompare(left.uploadedAtIso)
        case 'captured-asc':
          return preferredTimestamp(left).localeCompare(preferredTimestamp(right))
        case 'captured-desc':
          return preferredTimestamp(right).localeCompare(preferredTimestamp(left))
        case 'title-asc':
          return (left.title ?? '').localeCompare(right.title ?? '')
        case 'location-asc':
          return (left.locationLabel ?? '').localeCompare(right.locationLabel ?? '')
        default:
          return 0
      }
    })
  }, [activeTagFilters, fromDateFilter, galleryItems, locationFilter, sortOption, toDateFilter])

  const visibleItems = useMemo(
    () => filteredAndSortedItems.slice(0, visibleCount),
    [filteredAndSortedItems, visibleCount],
  )

  useEffect(() => {
    for (const item of visibleItems) {
      if (item.lockedReason) {
        continue
      }
      if (!item.mimeType?.startsWith('image/')) {
        continue
      }
      if (previewUrlMapRef.current.has(item.mediaId)) {
        continue
      }
      if (previewLoadingSetRef.current.has(item.mediaId)) {
        continue
      }
      if (previewErrorMapRef.current.has(item.mediaId)) {
        continue
      }
      void loadPreview(item.mediaId)
    }
  }, [visibleItems, loadPreview])

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFeedback('')

    if (role !== 'leader') {
      setFeedback('Only leaders can publish photos/videos.')
      return
    }

    if (selectedFile === null) {
      setFeedback('Select a photo or video before uploading.')
      return
    }

    try {
      const captureAtIso =
        captureAtInput.trim().length > 0 ? new Date(captureAtInput).toISOString() : undefined
      if (captureAtInput.trim().length > 0 && Number.isNaN(Date.parse(captureAtInput))) {
        throw new Error('Capture date/time must be a valid value.')
      }

      const locationLat = parseCoordinate(locationLatInput, 'Latitude', -90, 90)
      const locationLng = parseCoordinate(locationLngInput, 'Longitude', -180, 180)
      const tags = parseTagsInput(tagsInput)

      setFeedback('Encrypting and uploading...')

      const record = await encryptAndSignMedia({
        file: selectedFile,
        eventId: normalizeEventId(eventTitle),
        title,
        caption,
        uploaderId,
        groupPassphrase: passphrase,
        captureAtIso,
        locationLabel: optionalTrimmed(locationLabel),
        locationLat,
        locationLng,
        tags,
      })

      await storageAdapter.save(record)
      await refreshRecords()
      setSelectedFile(null)
      setCaptureAtInput('')
      setLocationLabel('')
      setLocationLatInput('')
      setLocationLngInput('')
      setTagsInput('')
      setFileInputResetKey((value) => value + 1)
      setFeedback('Upload complete. Parents can now browse this in the gallery.')
      setActiveTab('feed')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Upload failed unexpectedly.')
    }
  }

  async function handleClearIndex(): Promise<void> {
    try {
      await clearGalleryIndex()
      await refreshRecords()
      setFeedback('Local gallery index cleared. Metadata will be rebuilt from encrypted records.')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to clear local gallery index.')
    }
  }

  function handlePassphraseInputChange(value: string): void {
    resetPreviewState()
    setPassphrase(value)
  }

  function handleSortOptionChange(value: SortOption): void {
    setSortOption(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleFromDateFilterChange(value: string): void {
    setFromDateFilter(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleToDateFilterChange(value: string): void {
    setToDateFilter(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleLocationFilterChange(value: string): void {
    setLocationFilter(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleTagsFilterChange(value: string): void {
    setTagsFilter(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  async function handleFileSelection(file: File | null): Promise<void> {
    setSelectedFile(file)
    if (!file || !file.type.startsWith('image/')) {
      return
    }

    try {
      const parsed = (await exifr.parse(file, {
        pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
      })) as ParsedExif | null

      if (!parsed) {
        return
      }

      const candidateDate = parsed.DateTimeOriginal ?? parsed.CreateDate
      if (candidateDate instanceof Date && !Number.isNaN(candidateDate.getTime())) {
        setCaptureAtInput(toDateTimeLocalInputValue(candidateDate))
      }

      if (typeof parsed.latitude === 'number' && Number.isFinite(parsed.latitude)) {
        setLocationLatInput(parsed.latitude.toFixed(6))
      }
      if (typeof parsed.longitude === 'number' && Number.isFinite(parsed.longitude)) {
        setLocationLngInput(parsed.longitude.toFixed(6))
      }
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? `EXIF parsing failed: ${error.message}`
          : 'EXIF parsing failed. You can still enter metadata manually.',
      )
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Spejderbilleder</h1>
          <p className="subtitle">Privacy-first activity feed for parents and scout leaders.</p>
        </div>
        <div className="badges">
          <span className="badge">Backend: {configuredBackend}</span>
          <span className="badge">Records: {records.length}</span>
          <span className="badge">Visible: {filteredAndSortedItems.length}</span>
        </div>
      </header>

      <aside className="security-banner">{backendNotice()}</aside>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'feed' ? 'tab is-active' : 'tab'}
          onClick={() => setActiveTab('feed')}
        >
          Parent gallery
        </button>
        <button
          type="button"
          className={activeTab === 'upload' ? 'tab is-active' : 'tab'}
          onClick={() => setActiveTab('upload')}
        >
          Leader upload
        </button>
      </nav>

      {activeTab === 'feed' ? (
        <section className="panel">
          <div className="panel-toolbar">
            <label>
              Group passphrase
              <input
                type="password"
                value={passphrase}
                onChange={(event) => handlePassphraseInputChange(event.target.value)}
                placeholder="Required to decrypt feed metadata"
              />
            </label>
            <label>
              Sort by
              <select
                value={sortOption}
                onChange={(event) => handleSortOptionChange(event.target.value as SortOption)}
              >
                <option value="captured-desc">Capture date (newest)</option>
                <option value="captured-asc">Capture date (oldest)</option>
                <option value="uploaded-desc">Upload date (newest)</option>
                <option value="uploaded-asc">Upload date (oldest)</option>
                <option value="title-asc">Title (A-Z)</option>
                <option value="location-asc">Location (A-Z)</option>
              </select>
            </label>
            <label>
              From
              <input
                type="datetime-local"
                value={fromDateFilter}
                onChange={(event) => handleFromDateFilterChange(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="datetime-local"
                value={toDateFilter}
                onChange={(event) => handleToDateFilterChange(event.target.value)}
              />
            </label>
            <label>
              Location
              <input
                value={locationFilter}
                onChange={(event) => handleLocationFilterChange(event.target.value)}
                placeholder="Filter by location name"
              />
            </label>
            <label>
              Tags (comma separated)
              <input
                list="gallery-tags"
                value={tagsFilter}
                onChange={(event) => handleTagsFilterChange(event.target.value)}
                placeholder="campfire, sunset"
              />
              <datalist id="gallery-tags">
                {availableTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </label>
            <button type="button" onClick={() => void refreshRecords()}>
              Refresh
            </button>
            <button type="button" onClick={() => void handleClearIndex()}>
              Clear local index
            </button>
          </div>

          {indexingProgress ? (
            <p className="fine-print">
              Building gallery index {indexingProgress.processed}/{indexingProgress.total}...
            </p>
          ) : null}

          <div className="gallery">
            {visibleItems.length === 0 ? (
              <article className="gallery-card">
                <h2>No matching activity</h2>
                <p>Try adjusting filters or upload media from the “Leader upload” tab.</p>
              </article>
            ) : (
              visibleItems.map((item) => {
                const previewUrl = previewUrls[item.mediaId]
                const previewError = previewErrors[item.mediaId]
                const isLoadingPreview = previewLoading[item.mediaId] === true
                const isImage = item.mimeType?.startsWith('image/') === true

                return (
                  <article className="gallery-card" key={item.mediaId}>
                    {item.lockedReason ? (
                      <div className="preview-box preview-box--locked">
                        <h3>Encrypted item</h3>
                        <p>{item.lockedReason}</p>
                      </div>
                    ) : (
                      <div className="preview-box">
                        {isImage && previewUrl ? (
                          <img
                            src={previewUrl}
                            alt={item.title ?? item.fileName ?? 'Uploaded image'}
                            loading="lazy"
                          />
                        ) : isImage && isLoadingPreview ? (
                          <p>Loading preview...</p>
                        ) : isImage && previewError ? (
                          <>
                            <p>{previewError}</p>
                            <button type="button" onClick={() => void loadPreview(item.mediaId)}>
                              Retry preview
                            </button>
                          </>
                        ) : isImage ? (
                          <button type="button" onClick={() => void loadPreview(item.mediaId)}>
                            Load preview
                          </button>
                        ) : (
                          <p>Preview for this media type is not available yet.</p>
                        )}
                      </div>
                    )}

                    <div className="card-meta">
                      <span>{new Date(item.uploadedAtIso).toLocaleString()}</span>
                      <span>Event: {item.eventId}</span>
                      <span>Uploader: {item.uploaderId}</span>
                    </div>

                    <h2>{item.title ?? 'Encrypted item'}</h2>
                    {item.caption ? <p>{item.caption}</p> : null}

                    <p className="fine-print">
                      {item.fileName ?? 'Unknown file'} · {item.mimeType ?? 'Unknown type'} ·{' '}
                      {typeof item.fileSizeBytes === 'number' ? formatBytes(item.fileSizeBytes) : 'Unknown size'}
                    </p>

                    <p className="fine-print">
                      Capture: {item.captureAtIso ? new Date(item.captureAtIso).toLocaleString() : 'Unknown'}
                    </p>
                    <p className="fine-print">Location: {item.locationLabel ?? 'Unknown'}</p>
                    <p className="fine-print">
                      Tags: {item.tags.length > 0 ? item.tags.join(', ') : 'No tags'}
                    </p>
                    <p className={item.signatureValid ? 'signature-ok' : 'signature-warning'}>
                      Signature: {item.signatureValid ? 'verified' : 'invalid'}
                    </p>
                  </article>
                )
              })
            )}
          </div>

          {visibleCount < filteredAndSortedItems.length ? (
            <div className="load-more-row">
              <button type="button" onClick={() => setVisibleCount((count) => count + VISIBLE_INCREMENT)}>
                Load more photos
              </button>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="panel">
          <form className="form" onSubmit={(event) => void handleUploadSubmit(event)}>
            <label>
              Role
              <select
                value={role}
                onChange={(event) => {
                  const nextRole = event.target.value
                  if (nextRole === 'leader' || nextRole === 'parent') {
                    setRole(nextRole)
                  }
                }}
              >
                <option value="leader">leader</option>
                <option value="parent">parent</option>
              </select>
            </label>
            <label>
              Uploader ID
              <input
                value={uploaderId}
                onChange={(event) => setUploaderId(event.target.value)}
                required
              />
            </label>
            <label>
              Event title
              <input
                value={eventTitle}
                onChange={(event) => setEventTitle(event.target.value)}
                required
              />
            </label>
            <label>
              Post title
              <input value={title} onChange={(event) => setTitle(event.target.value)} required />
            </label>
            <label>
              Caption
              <textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                rows={4}
                required
              />
            </label>
            <label>
              Capture date/time
              <input
                type="datetime-local"
                value={captureAtInput}
                onChange={(event) => setCaptureAtInput(event.target.value)}
              />
            </label>
            <label>
              Location label
              <input
                value={locationLabel}
                onChange={(event) => setLocationLabel(event.target.value)}
                placeholder="Shelter by the lake"
              />
            </label>
            <label>
              Latitude
              <input
                type="number"
                step="0.000001"
                value={locationLatInput}
                onChange={(event) => setLocationLatInput(event.target.value)}
                placeholder="55.676098"
              />
            </label>
            <label>
              Longitude
              <input
                type="number"
                step="0.000001"
                value={locationLngInput}
                onChange={(event) => setLocationLngInput(event.target.value)}
                placeholder="12.568337"
              />
            </label>
            <label>
              Tags (comma separated)
              <input
                value={tagsInput}
                onChange={(event) => setTagsInput(event.target.value)}
                placeholder="campfire, songs, sunset"
              />
            </label>
            <label>
              Group passphrase
              <input
                type="password"
                value={passphrase}
                onChange={(event) => handlePassphraseInputChange(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <label>
              Photo or video
              <input
                key={fileInputResetKey}
                type="file"
                accept="image/*,video/*"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null
                  void handleFileSelection(nextFile)
                }}
                required
              />
            </label>
            <button type="submit">Encrypt and publish</button>
          </form>

          {feedback ? <p className="feedback">{feedback}</p> : null}
        </section>
      )}
    </div>
  )
}

export default App
