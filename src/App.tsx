import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import { decryptRecordSummary, encryptAndSignMedia } from './lib/media'
import { createStorageAdapter, readConfiguredBackend } from './storage/factory'
import type { StoredMediaRecord, UserRole } from './types'

interface FeedCard {
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
  lockedReason?: string
}

const configuredBackend = readConfiguredBackend()
const storageAdapter = createStorageAdapter(configuredBackend)

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

function App() {
  const [activeTab, setActiveTab] = useState<'feed' | 'upload'>('feed')
  const [records, setRecords] = useState<StoredMediaRecord[]>([])
  const [feedCards, setFeedCards] = useState<FeedCard[]>([])

  const [role, setRole] = useState<UserRole>('leader')
  const [uploaderId, setUploaderId] = useState('leader-lars')
  const [eventTitle, setEventTitle] = useState('Monday campfire')
  const [title, setTitle] = useState('Campfire songs at sunset')
  const [caption, setCaption] = useState('The wolves practiced guitar and sang together.')
  const [passphrase, setPassphrase] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [feedback, setFeedback] = useState<string>('')
  const [fileInputResetKey, setFileInputResetKey] = useState(0)

  async function refreshRecords(): Promise<void> {
    const listed = await storageAdapter.list()
    setRecords(sortNewestFirst(listed))
  }

  useEffect(() => {
    let cancelled = false

    void storageAdapter
      .list()
      .then((listed) => {
        if (!cancelled) {
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
  }, [])

  useEffect(() => {
    let cancelled = false

    async function rebuildCards(): Promise<void> {
      const nextCards: FeedCard[] = []

      for (const record of sortNewestFirst(records)) {
        try {
          const summary = await decryptRecordSummary(record, passphrase)
          nextCards.push({
            mediaId: record.manifest.mediaId,
            eventId: record.manifest.eventId,
            uploaderId: record.manifest.uploaderId,
            uploadedAtIso: record.manifest.uploadedAtIso,
            title: summary.metadata.title,
            caption: summary.metadata.caption,
            fileName: summary.metadata.fileName,
            mimeType: summary.metadata.mimeType,
            fileSizeBytes: summary.metadata.fileSizeBytes,
            signatureValid: summary.signatureValid,
          })
        } catch (error) {
          nextCards.push({
            mediaId: record.manifest.mediaId,
            eventId: record.manifest.eventId,
            uploaderId: record.manifest.uploaderId,
            uploadedAtIso: record.manifest.uploadedAtIso,
            lockedReason:
              error instanceof Error ? error.message : 'Could not decrypt with this passphrase.',
          })
        }
      }

      if (!cancelled) {
        setFeedCards(nextCards)
      }
    }

    void rebuildCards()

    return () => {
      cancelled = true
    }
  }, [records, passphrase])

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
      setFeedback('Encrypting and uploading...')

      const record = await encryptAndSignMedia({
        file: selectedFile,
        eventId: normalizeEventId(eventTitle),
        title,
        caption,
        uploaderId,
        groupPassphrase: passphrase,
      })

      await storageAdapter.save(record)
      await refreshRecords()
      setSelectedFile(null)
      setFileInputResetKey((value) => value + 1)
      setFeedback('Upload complete. Parents can now unlock this in the feed.')
      setActiveTab('feed')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Upload failed unexpectedly.')
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
        </div>
      </header>

      <aside className="security-banner">{backendNotice()}</aside>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'feed' ? 'tab is-active' : 'tab'}
          onClick={() => setActiveTab('feed')}
        >
          Parent feed
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
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Required to decrypt feed metadata"
              />
            </label>
            <button type="button" onClick={() => void refreshRecords()}>
              Refresh
            </button>
          </div>

          <div className="cards">
            {feedCards.length === 0 ? (
              <article className="card">
                <h2>No activity yet</h2>
                <p>Leaders can start uploading from the “Leader upload” tab.</p>
              </article>
            ) : (
              feedCards.map((card) => (
                <article className="card" key={card.mediaId}>
                  <div className="card-meta">
                    <span>{new Date(card.uploadedAtIso).toLocaleString()}</span>
                    <span>Event: {card.eventId}</span>
                    <span>Uploader: {card.uploaderId}</span>
                  </div>
                  {card.lockedReason ? (
                    <>
                      <h2>Encrypted item</h2>
                      <p>{card.lockedReason}</p>
                    </>
                  ) : (
                    <>
                      <h2>{card.title}</h2>
                      <p>{card.caption}</p>
                      <p className="fine-print">
                        {card.fileName} · {card.mimeType} ·{' '}
                        {typeof card.fileSizeBytes === 'number'
                          ? formatBytes(card.fileSizeBytes)
                          : 'Unknown size'}
                      </p>
                      <p
                        className={card.signatureValid ? 'signature-ok' : 'signature-warning'}
                      >
                        Signature: {card.signatureValid ? 'verified' : 'invalid'}
                      </p>
                    </>
                  )}
                </article>
              ))
            )}
          </div>
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
              Group passphrase
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
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
                  setSelectedFile(nextFile)
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
