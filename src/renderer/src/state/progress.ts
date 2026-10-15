// Long tasks' progress from main ('progress' events, keyed by TaskProgress.key): opening a
// chiptune set, an import, a folder scan, the one-time yt-dlp download. A finished task stays a
// moment (`done`) so its bar can complete before it goes.
import { create } from 'zustand'
import type { TaskProgress } from '@shared/types'
import { ghost } from '../ghost'

/** How long a finished task's bar stays (it fills, then fades). */
const DONE_LINGER_MS = 700

export const useTasks = create<Record<string, TaskProgress>>(() => ({}))

const expiry = new Map<string, number>()

export function applyTaskProgress(p: TaskProgress): void {
  if (!p || typeof p.key !== 'string') return
  const t = expiry.get(p.key)
  if (t) {
    window.clearTimeout(t)
    expiry.delete(p.key)
  }
  useTasks.setState({ [p.key]: p })
  if (p.done) {
    expiry.set(
      p.key,
      window.setTimeout(() => {
        expiry.delete(p.key)
        useTasks.setState((s) => {
          if (s[p.key] !== p) return s
          const { [p.key]: _gone, ...rest } = s
          return rest
        }, true)
      }, DONE_LINGER_MS)
    )
  }
}

/** The progress of the task `key` (null when none is running). */
export function useTask(key: string | null | undefined): TaskProgress | null {
  return useTasks((s) => (key ? (s[key] ?? null) : null))
}

let started = false
export function initTaskProgress(): void {
  if (started) return
  started = true
  ghost().on('progress', applyTaskProgress)
}
