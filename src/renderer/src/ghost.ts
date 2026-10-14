// The single handle the UI uses to talk to the app. Installed by main.tsx (preload or mock).
import type { GhostAPI } from '@shared/api'

export const ghost = (): GhostAPI => window.ghost
export const isMock = (): boolean => !!import.meta.env.GHOST_WEB_MOCK
