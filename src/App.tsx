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
import { SCOUT_TAGS, normalizeScoutTags } from './lib/tags'
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
  locationLat?: number
  locationLng?: number
  tags: string[]
  lockedReason?: string
}

interface IndexingProgress {
  processed: number
  total: number
}

interface ParsedExif {
  DateTimeOriginal?: Date
  CreateDate?: Date
  latitude?: number
  longitude?: number
}

interface UploadAutoMetadata {
  title: string
  caption: string
  captureAtIso?: string
  locationLabel?: string
  locationLat?: number
  locationLng?: number
}

interface UploadCandidate {
  id: string
  file: File
  metadata: UploadAutoMetadata
  warning?: string
}

type SortOption = 'date-desc' | 'date-asc'
type AuthState = 'locked' | 'validating' | 'unlocked'

const configuredBackend = readConfiguredBackend()
const storageAdapter = createStorageAdapter(configuredBackend)
const INDEX_BATCH_SIZE = 25
const INITIAL_VISIBLE_COUNT = 80
const VISIBLE_INCREMENT = 80
const branchReference =
  typeof import.meta.env.VITE_BRANCH_REF === 'string' && import.meta.env.VITE_BRANCH_REF.trim().length > 0
    ? import.meta.env.VITE_BRANCH_REF.trim()
    : 'main'

function normalizeEventId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const date = new Date().toISOString().slice(0, 10)
  return `${slug || 'aktivitet'}-${date}`
}

function buildAutoEventId(): string {
  return normalizeEventId('masse-upload')
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
    return 'Demotilstand: krypterede poster gemmes kun i browserens localStorage.'
  }
  return 'Signer-tilstand: appen forventer en privat backend på VITE_SIGNER_API_BASE til autentificeret, signeret lageradgang.'
}

function sortNewestFirst(records: StoredMediaRecord[]): StoredMediaRecord[] {
  return [...records].sort((left, right) =>
    right.manifest.uploadedAtIso.localeCompare(left.manifest.uploadedAtIso),
  )
}

function deriveTitleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  const normalized = withoutExtension.replace(/[_-]+/g, ' ').trim()
  return normalized.length > 0 ? normalized : 'Upload uden titel'
}

function buildBaseMetadata(file: File): UploadAutoMetadata {
  const fallbackCapturedAt =
    typeof file.lastModified === 'number' && file.lastModified > 0
      ? new Date(file.lastModified).toISOString()
      : undefined

  return {
    title: deriveTitleFromFileName(file.name),
    caption: '',
    captureAtIso: fallbackCapturedAt,
  }
}

function buildUploadCandidateId(file: File, index: number): string {
  return `${file.name}:${file.size}:${file.lastModified}:${index}`
}

async function extractAutoMetadata(file: File): Promise<{ metadata: UploadAutoMetadata; warning?: string }> {
  const base = buildBaseMetadata(file)

  if (!file.type.startsWith('image/')) {
    return { metadata: base }
  }

  try {
    const parsed = (await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
    })) as ParsedExif | null

    if (!parsed) {
      return { metadata: base }
    }

    const candidateDate = parsed.DateTimeOriginal ?? parsed.CreateDate
    const captureAtIso =
      candidateDate instanceof Date && !Number.isNaN(candidateDate.getTime())
        ? candidateDate.toISOString()
        : base.captureAtIso

    return {
      metadata: {
        ...base,
        captureAtIso,
        locationLat:
          typeof parsed.latitude === 'number' && Number.isFinite(parsed.latitude)
            ? parsed.latitude
            : undefined,
        locationLng:
          typeof parsed.longitude === 'number' && Number.isFinite(parsed.longitude)
            ? parsed.longitude
            : undefined,
      },
    }
  } catch (error) {
    return {
      metadata: base,
      warning:
        error instanceof Error
          ? `Metadata-udtræk faldt tilbage til filværdier: ${error.message}`
          : 'Metadata-udtræk faldt tilbage til filværdier for denne fil.',
    }
  }
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
    locationLat: entry.locationLat,
    locationLng: entry.locationLng,
    tags: normalizeScoutTags(entry.tags),
  }
}

function toggleTag(currentTags: string[], targetTag: string): string[] {
  if (currentTags.includes(targetTag)) {
    return currentTags.filter((tag) => tag !== targetTag)
  }
  return [...currentTags, targetTag]
}

function App() {
  const [activeTab, setActiveTab] = useState<'feed' | 'upload'>('feed')
  const [records, setRecords] = useState<StoredMediaRecord[]>([])
  const [recordsLoaded, setRecordsLoaded] = useState(false)
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([])
  const [indexingProgress, setIndexingProgress] = useState<IndexingProgress | null>(null)

  const [authState, setAuthState] = useState<AuthState>('locked')
  const [passphraseInput, setPassphraseInput] = useState('')
  const [sessionPassphrase, setSessionPassphrase] = useState('')
  const [passphraseError, setPassphraseError] = useState('')

  const [role, setRole] = useState<UserRole>('leader')
  const [uploaderId, setUploaderId] = useState('')
  const [selectedUploadTags, setSelectedUploadTags] = useState<string[]>([])
  const [uploadCandidates, setUploadCandidates] = useState<UploadCandidate[]>([])
  const [feedback, setFeedback] = useState<string>('')
  const [fileInputResetKey, setFileInputResetKey] = useState(0)

  const [sortOption, setSortOption] = useState<SortOption>('date-desc')
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([])
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [detailsMediaId, setDetailsMediaId] = useState<string | null>(null)

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({})
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({})

  const previewUrlMapRef = useRef<Map<string, string>>(new Map())
  const previewLoadingSetRef = useRef<Set<string>>(new Set())
  const previewErrorMapRef = useRef<Map<string, string>>(new Map())
  const passphraseValidationAttemptRef = useRef(0)
  const fileSelectionAttemptRef = useRef(0)

  const recordByMediaId = useMemo(
    () => new Map(records.map((record) => [record.manifest.mediaId, record])),
    [records],
  )

  const galleryItemByMediaId = useMemo(
    () => new Map(galleryItems.map((item) => [item.mediaId, item])),
    [galleryItems],
  )

  const detailsItem = useMemo(
    () => (detailsMediaId ? galleryItemByMediaId.get(detailsMediaId) : undefined),
    [detailsMediaId, galleryItemByMediaId],
  )

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

  const refreshRecords = useCallback(async (): Promise<void> => {
    const listed = await storageAdapter.list()
    resetPreviewState()
    setRecords(sortNewestFirst(listed))
    setRecordsLoaded(true)
  }, [resetPreviewState])

  const validatePassphraseForRecords = useCallback(
    async (passphraseToCheck: string, recordsToCheck: StoredMediaRecord[]): Promise<boolean> => {
      for (const record of recordsToCheck) {
        try {
          await decryptRecordSummary(record, passphraseToCheck)
        } catch {
          return false
        }
      }
      return true
    },
    [],
  )

  const loadPreview = useCallback(
    async (mediaId: string): Promise<void> => {
      if (authState !== 'unlocked') {
        return
      }
      if (previewUrlMapRef.current.has(mediaId) || previewLoadingSetRef.current.has(mediaId)) {
        return
      }

      const record = recordByMediaId.get(mediaId)
      if (!record) {
        return
      }

      const trimmedPassphrase = sessionPassphrase.trim()
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
          throw new Error('Forhåndsvisning er i øjeblikket kun tilgængelig for billedfiler.')
        }
        const objectUrl = URL.createObjectURL(media.blob)
        const previous = previewUrlMapRef.current.get(mediaId)
        if (previous) {
          URL.revokeObjectURL(previous)
        }
        previewUrlMapRef.current.set(mediaId, objectUrl)
        setPreviewUrls((current) => ({ ...current, [mediaId]: objectUrl }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Kunne ikke indlæse forhåndsvisning.'
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
    [authState, recordByMediaId, sessionPassphrase],
  )

  useEffect(() => {
    let cancelled = false

    void storageAdapter
      .list()
      .then((listed) => {
        if (!cancelled) {
          resetPreviewState()
          setRecords(sortNewestFirst(listed))
          setRecordsLoaded(true)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFeedback(error instanceof Error ? error.message : 'Kunne ikke indlæse poster.')
          setRecordsLoaded(true)
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
    if (authState !== 'unlocked' || sessionPassphrase.length < 8 || records.length === 0) {
      return
    }

    let cancelled = false
    void validatePassphraseForRecords(sessionPassphrase, records).then((matches) => {
      if (cancelled || matches) {
        return
      }

      setAuthState('locked')
      setSessionPassphrase('')
      setPassphraseError('Adgangskoden matcher ikke alle eksisterende fotos/videoer. Log ind igen.')
      setActiveTab('feed')
      setGalleryItems([])
      setDetailsMediaId(null)
      resetPreviewState()
    })

    return () => {
      cancelled = true
    }
  }, [authState, records, resetPreviewState, sessionPassphrase, validatePassphraseForRecords])

  useEffect(() => {
    let cancelled = false

    async function rebuildGalleryItems(): Promise<void> {
      if (authState !== 'unlocked') {
        setGalleryItems([])
        setIndexingProgress(null)
        return
      }

      const sortedRecords = sortNewestFirst(records)
      if (sortedRecords.length === 0) {
        setGalleryItems([])
        setIndexingProgress(null)
        return
      }

      const trimmedPassphrase = sessionPassphrase.trim()
      if (trimmedPassphrase.length < 8) {
        setGalleryItems([])
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
              locationLat: summary.metadata.locationLat,
              locationLng: summary.metadata.locationLng,
              tags: normalizeScoutTags(summary.metadata.tags),
              signatureValid: summary.signatureValid,
            }
            await putGalleryIndexEntry(entry)
            nextItems.push(toGalleryItem(record, entry))
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Kunne ikke dekryptere med denne adgangskode.'
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
        setFeedback(error instanceof Error ? error.message : 'Kunne ikke opbygge galleriindeks.')
        setIndexingProgress(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [authState, records, sessionPassphrase])

  const filteredAndSortedItems = useMemo(() => {
    const filtered = galleryItems.filter((item) => {
      if (item.lockedReason) {
        return activeTagFilters.length === 0
      }

      if (activeTagFilters.length > 0) {
        const tagSet = new Set(item.tags.map((tag) => tag.toLowerCase()))
        if (!activeTagFilters.every((tag) => tagSet.has(tag.toLowerCase()))) {
          return false
        }
      }

      return true
    })

    return filtered.sort((left, right) => {
      if (sortOption === 'date-asc') {
        return preferredTimestamp(left).localeCompare(preferredTimestamp(right))
      }
      return preferredTimestamp(right).localeCompare(preferredTimestamp(left))
    })
  }, [activeTagFilters, galleryItems, sortOption])

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

  async function handlePassphraseSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setPassphraseError('')
    setFeedback('')

    if (!recordsLoaded) {
      setPassphraseError('Krypterede poster indlæses stadig. Vent et øjeblik og prøv igen.')
      return
    }

    const trimmedPassphrase = passphraseInput.trim()
    if (trimmedPassphrase.length < 8) {
      setPassphraseError('Gruppens adgangskode skal være mindst 8 tegn.')
      return
    }

    const attemptId = ++passphraseValidationAttemptRef.current
    setAuthState('validating')

    try {
      const matchesAll =
        records.length === 0
          ? true
          : await validatePassphraseForRecords(trimmedPassphrase, records)

      if (attemptId !== passphraseValidationAttemptRef.current) {
        return
      }

      if (!matchesAll) {
        setAuthState('locked')
        setPassphraseError('Adgangskoden matcher ikke alle eksisterende fotos/videoer.')
        return
      }

      setSessionPassphrase(trimmedPassphrase)
      setPassphraseInput('')
      setPassphraseError('')
      setAuthState('unlocked')
    } catch (error) {
      if (attemptId !== passphraseValidationAttemptRef.current) {
        return
      }
      setAuthState('locked')
      setPassphraseError(error instanceof Error ? error.message : 'Kunne ikke validere adgangskoden.')
    }
  }

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFeedback('')

    if (authState !== 'unlocked') {
      setFeedback('Indtast gruppens adgangskode før upload.')
      return
    }

    if (role !== 'leader') {
      setFeedback('Kun ledere kan udgive fotos/videoer.')
      return
    }

    const normalizedUploaderId = uploaderId.trim()
    if (normalizedUploaderId.length === 0) {
      setFeedback('Uploader-id er påkrævet.')
      return
    }

    if (uploadCandidates.length === 0) {
      setFeedback('Vælg et eller flere fotos/videoer før upload.')
      return
    }

    setFeedback('Krypterer og uploader valgte filer...')
    const selectedTags = normalizeScoutTags(selectedUploadTags)
    const eventId = buildAutoEventId()
    let successCount = 0
    const failedUploads: string[] = []

    for (const candidate of uploadCandidates) {
      try {
        const record = await encryptAndSignMedia({
          file: candidate.file,
          eventId,
          title: candidate.metadata.title,
          caption: candidate.metadata.caption,
          uploaderId: normalizedUploaderId,
          groupPassphrase: sessionPassphrase,
          captureAtIso: candidate.metadata.captureAtIso,
          locationLabel: candidate.metadata.locationLabel,
          locationLat: candidate.metadata.locationLat,
          locationLng: candidate.metadata.locationLng,
          tags: selectedTags,
        })
        await storageAdapter.save(record)
        successCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Uventet uploadfejl.'
        failedUploads.push(`${candidate.file.name}: ${message}`)
      }
    }

    await refreshRecords()
    setUploadCandidates([])
    setSelectedUploadTags([])
    setFileInputResetKey((value) => value + 1)
    setActiveTab('feed')

    if (failedUploads.length === 0) {
      setFeedback(`Upload fuldført: ${successCount} fil(er) udgivet.`)
      return
    }

    setFeedback(
      `Uploadet ${successCount}/${uploadCandidates.length}. Fejlede filer: ${failedUploads.join(' | ')}`,
    )
  }

  async function handleClearIndex(): Promise<void> {
    try {
      await clearGalleryIndex()
      await refreshRecords()
      setFeedback('Lokalt galleriindeks ryddet. Metadata opbygges igen fra krypterede poster.')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Kunne ikke rydde lokalt galleriindeks.')
    }
  }

  function handleSortOptionChange(value: SortOption): void {
    setSortOption(value)
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleGalleryTagToggle(tag: string): void {
    setActiveTagFilters((current) => toggleTag(current, tag))
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }

  function handleUploadTagToggle(tag: string): void {
    setSelectedUploadTags((current) => toggleTag(current, tag))
  }

  async function handleFileSelection(fileList: FileList | null): Promise<void> {
    const files = Array.from(fileList ?? [])
    setFeedback('')

    if (files.length === 0) {
      setUploadCandidates([])
      return
    }

    const attemptId = ++fileSelectionAttemptRef.current
    const extractedCandidates = await Promise.all(
      files.map(async (file, index) => {
        const extracted = await extractAutoMetadata(file)
        return {
          id: buildUploadCandidateId(file, index),
          file,
          metadata: extracted.metadata,
          warning: extracted.warning,
        } satisfies UploadCandidate
      }),
    )

    if (attemptId !== fileSelectionAttemptRef.current) {
      return
    }

    setUploadCandidates(extractedCandidates)

    if (extractedCandidates.some((candidate) => candidate.warning)) {
      setFeedback(
        'Valgte filer er klar. Nogle filer havde begrænset metadata-udtræk og bruger filstandarder.',
      )
      return
    }

    setFeedback(`Valgt ${extractedCandidates.length} fil(er). Metadata er udtrukket hvor muligt.`)
  }

  if (authState !== 'unlocked') {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div>
            <h1>Spejderbilleder</h1>
            <p className="subtitle">Privatlivsfokuseret aktivitetsfeed for forældre og spejderledere.</p>
          </div>
          <div className="badges">
            <span className="badge">Lager: {configuredBackend}</span>
            <span className="badge">Poster: {records.length}</span>
          </div>
        </header>

        <aside className="security-banner">{backendNotice()}</aside>

        <section className="panel auth-panel">
          <h2>Lås gruppens medier op</h2>
          <p className="fine-print">
            Indtast den fælles gruppeadgangskode for at åbne galleri- og uploadsiderne.
          </p>
          <form className="form" onSubmit={(event) => void handlePassphraseSubmit(event)}>
            <label>
              Gruppeadgangskode
              <input
                type="password"
                value={passphraseInput}
                onChange={(event) => setPassphraseInput(event.target.value)}
                minLength={8}
                required
                placeholder="Minimum 8 tegn"
              />
            </label>
            <button type="submit" disabled={!recordsLoaded || authState === 'validating'}>
              {authState === 'validating' ? 'Kontrollerer adgangskode...' : 'Lås op'}
            </button>
          </form>
          {passphraseError ? <p className="feedback feedback--error">{passphraseError}</p> : null}
          {!recordsLoaded ? (
            <p className="fine-print">Indlæser krypterede poster…</p>
          ) : records.length === 0 ? (
            <p className="fine-print">
              Ingen poster fundet endnu. En hvilken som helst adgangskode kan initialisere dette galleri.
            </p>
          ) : (
            <p className="fine-print">
              {records.length} krypterede post(er) fundet. Adgangskoden skal matche alle eksisterende poster.
            </p>
          )}
          {feedback ? <p className="feedback">{feedback}</p> : null}
        </section>
        <p className="app-footnote">Grenreference: {branchReference}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Spejderbilleder</h1>
          <p className="subtitle">Privatlivsfokuseret aktivitetsfeed for forældre og spejderledere.</p>
        </div>
        <div className="badges">
          <span className="badge">Lager: {configuredBackend}</span>
          <span className="badge">Poster: {records.length}</span>
          <span className="badge">Synlige: {filteredAndSortedItems.length}</span>
        </div>
      </header>

      <aside className="security-banner">{backendNotice()}</aside>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'feed' ? 'tab is-active' : 'tab'}
          onClick={() => setActiveTab('feed')}
        >
          Forældregalleri
        </button>
        <button
          type="button"
          className={activeTab === 'upload' ? 'tab is-active' : 'tab'}
          onClick={() => setActiveTab('upload')}
        >
          Lederupload
        </button>
      </nav>

      {activeTab === 'feed' ? (
        <section className="panel">
          <div className="panel-toolbar">
            <label>
              Sorter efter dato
              <select
                value={sortOption}
                onChange={(event) => handleSortOptionChange(event.target.value as SortOption)}
              >
                <option value="date-desc">Nyeste først</option>
                <option value="date-asc">Ældste først</option>
              </select>
            </label>
            <div>
              <p className="toggle-heading">Tags</p>
              <div className="tag-row">
                {SCOUT_TAGS.map((tag) => {
                  const isActive = activeTagFilters.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={isActive ? 'tag-toggle is-active' : 'tag-toggle'}
                      onClick={() => handleGalleryTagToggle(tag)}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </div>
            <button type="button" onClick={() => void refreshRecords()}>
              Opdater
            </button>
            <button type="button" onClick={() => void handleClearIndex()}>
              Ryd lokalt indeks
            </button>
          </div>

          {indexingProgress ? (
            <p className="fine-print">
              Opbygger galleriindeks {indexingProgress.processed}/{indexingProgress.total}...
            </p>
          ) : null}

          {detailsItem && !detailsItem.lockedReason ? (
            <aside className="details-panel">
              <div className="details-panel__header">
                <h2>Foto/video-detaljer</h2>
                <button type="button" onClick={() => setDetailsMediaId(null)}>
                  Luk
                </button>
              </div>
              <p>
                <strong>Aktivitet:</strong> {detailsItem.eventId}
              </p>
              <p>
                <strong>Uploader:</strong> {detailsItem.uploaderId}
              </p>
              <p>
                <strong>Uploadet:</strong> {new Date(detailsItem.uploadedAtIso).toLocaleString()}
              </p>
              <p>
                <strong>Optaget:</strong>{' '}
                {detailsItem.captureAtIso ? new Date(detailsItem.captureAtIso).toLocaleString() : 'Ukendt'}
              </p>
              <p>
                <strong>Fil:</strong> {detailsItem.fileName ?? 'Ukendt fil'}
              </p>
              <p>
                <strong>Type:</strong> {detailsItem.mimeType ?? 'Ukendt type'}
              </p>
              <p>
                <strong>Størrelse:</strong>{' '}
                {typeof detailsItem.fileSizeBytes === 'number'
                  ? formatBytes(detailsItem.fileSizeBytes)
                  : 'Ukendt størrelse'}
              </p>
              <p>
                <strong>Sted:</strong> {detailsItem.locationLabel ?? 'Ukendt'}
              </p>
              <p>
                <strong>Koordinater:</strong>{' '}
                {typeof detailsItem.locationLat === 'number' && typeof detailsItem.locationLng === 'number'
                  ? `${detailsItem.locationLat.toFixed(6)}, ${detailsItem.locationLng.toFixed(6)}`
                  : 'Ukendt'}
              </p>
              <p>
                <strong>Tags:</strong> {detailsItem.tags.length > 0 ? detailsItem.tags.join(', ') : 'Ingen tags'}
              </p>
              <p className={detailsItem.signatureValid ? 'signature-ok' : 'signature-warning'}>
                Signatur: {detailsItem.signatureValid ? 'verificeret' : 'ugyldig'}
              </p>
            </aside>
          ) : null}

          <div className="gallery">
            {visibleItems.length === 0 ? (
              <article className="gallery-card">
                <h2>Ingen matchende aktiviteter</h2>
                <p>Prøv at justere tags eller upload medier fra fanen “Lederupload”.</p>
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
                        <h3>Krypteret element</h3>
                        <p>{item.lockedReason}</p>
                      </div>
                    ) : (
                      <div className="preview-box">
                        {isImage && previewUrl ? (
                          <img
                            src={previewUrl}
                            alt={item.title ?? item.fileName ?? 'Uploadet billede'}
                            loading="lazy"
                          />
                        ) : isImage && isLoadingPreview ? (
                          <p>Indlæser forhåndsvisning...</p>
                        ) : isImage && previewError ? (
                          <>
                            <p>{previewError}</p>
                            <button type="button" onClick={() => void loadPreview(item.mediaId)}>
                              Prøv igen
                            </button>
                          </>
                        ) : isImage ? (
                          <button type="button" onClick={() => void loadPreview(item.mediaId)}>
                            Indlæs forhåndsvisning
                          </button>
                        ) : (
                          <p>Forhåndsvisning for denne filtype er ikke tilgængelig endnu.</p>
                        )}
                      </div>
                    )}

                    <div className="card-meta">
                      <span>{new Date(preferredTimestamp(item)).toLocaleString()}</span>
                    </div>

                    <h2>{item.title ?? 'Krypteret element'}</h2>
                    {item.caption ? <p>{item.caption}</p> : null}

                    {!item.lockedReason ? (
                      <button type="button" onClick={() => setDetailsMediaId(item.mediaId)}>
                        Detaljer
                      </button>
                    ) : null}
                  </article>
                )
              })
            )}
          </div>

          {visibleCount < filteredAndSortedItems.length ? (
            <div className="load-more-row">
              <button type="button" onClick={() => setVisibleCount((count) => count + VISIBLE_INCREMENT)}>
                Indlæs flere billeder
              </button>
            </div>
          ) : null}

          {feedback ? <p className="feedback">{feedback}</p> : null}
        </section>
      ) : (
        <section className="panel">
          <form className="form" onSubmit={(event) => void handleUploadSubmit(event)}>
            <label>
              Rolle
              <select
                value={role}
                onChange={(event) => {
                  const nextRole = event.target.value
                  if (nextRole === 'leader' || nextRole === 'parent') {
                    setRole(nextRole)
                  }
                }}
              >
                <option value="leader">leder</option>
                <option value="parent">forælder</option>
              </select>
            </label>
            <label>
              Uploader-id
              <input
                value={uploaderId}
                onChange={(event) => setUploaderId(event.target.value)}
                placeholder="fx leder-lars"
                required
              />
            </label>

            <div>
              <p className="toggle-heading">Upload-tags</p>
              <div className="tag-row">
                {SCOUT_TAGS.map((tag) => {
                  const isActive = selectedUploadTags.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={isActive ? 'tag-toggle is-active' : 'tag-toggle'}
                      onClick={() => handleUploadTagToggle(tag)}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </div>

            <label>
              Fotos eller videoer
              <input
                key={fileInputResetKey}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={(event) => void handleFileSelection(event.target.files)}
                required
              />
            </label>

            {uploadCandidates.length > 0 ? (
              <div className="candidate-list">
                <p className="toggle-heading">Registreret metadata</p>
                <div className="candidate-list__items">
                  {uploadCandidates.map((candidate) => (
                    <article key={candidate.id} className="candidate-card">
                      <p>
                        <strong>{candidate.file.name}</strong>
                      </p>
                      <p>
                        <strong>Titel:</strong> {candidate.metadata.title}
                      </p>
                      <p>
                        <strong>Optaget:</strong>{' '}
                        {candidate.metadata.captureAtIso
                          ? new Date(candidate.metadata.captureAtIso).toLocaleString()
                          : 'Ukendt'}
                      </p>
                      <p>
                        <strong>Koordinater:</strong>{' '}
                        {typeof candidate.metadata.locationLat === 'number' &&
                        typeof candidate.metadata.locationLng === 'number'
                          ? `${candidate.metadata.locationLat.toFixed(6)}, ${candidate.metadata.locationLng.toFixed(6)}`
                          : 'Ukendt'}
                      </p>
                      {candidate.warning ? <p className="fine-print">{candidate.warning}</p> : null}
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <button type="submit">Krypter og udgiv valgte filer</button>
          </form>

          {feedback ? <p className="feedback">{feedback}</p> : null}
        </section>
      )}
      <p className="app-footnote">Grenreference: {branchReference}</p>
    </div>
  )
}

export default App
