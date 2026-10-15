// Stable views of the player store for the Play screen / Now Playing / queue.
//
// state/player.ts folds every push into the store with structural sharing (lib/share.ts), so
// `current`, `currentAnalysis` and `queue` keep their identity across heartbeats, volume steps
// and seeks, and change exactly when their contents do. These used to be hand-written
// "same enough" comparisons on top, which also hid real changes to fields they didn't list
// (album title, composers, duration, source bitrate, a queue row's title or cover).
import type { QueueItem, TrackAnalysis, TrackView } from '@shared/types'
import { usePlayer } from '../../state/player'

/** The current track (re-renders only when it changes). */
export function useCurrentTrack(): TrackView | null {
  return usePlayer((s) => s.current)
}

/** The current track's offline analysis (re-renders only when it changes). */
export function useCurrentAnalysis(): TrackAnalysis | null {
  return usePlayer((s) => s.currentAnalysis)
}

/** The queue (re-renders only when it changes). */
export function useStableQueue(): QueueItem[] {
  return usePlayer((s) => s.queue)
}
