/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STORAGE_BACKEND?: 'mock' | 's3-signer'
  readonly VITE_SIGNER_API_BASE?: string
  readonly VITE_BRANCH_REF?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
