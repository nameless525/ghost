import type { GhostAPI } from '../shared/api'

declare global {
  interface Window {
    ghost: GhostAPI
  }
}
export {}
