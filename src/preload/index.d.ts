import type { DispatchApi } from '@shared/ipc'

declare global {
  interface Window {
    dispatchApi: DispatchApi
  }
}

export {}
