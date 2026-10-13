/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `http` (default): the console API with sign-in. `mock`: sample data without sign-in, never in a production build. */
  readonly VITE_SENTINEL_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
