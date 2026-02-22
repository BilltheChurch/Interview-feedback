/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EDGE_BASE_URL?: string;
  readonly VITE_WORKER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
