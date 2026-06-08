/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_BACKEND?: 'mock' | 's3-signer'
  readonly VITE_SIGNER_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
