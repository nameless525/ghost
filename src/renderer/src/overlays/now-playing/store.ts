// Structurally stable views of the player store. The engine pushes a fresh PlayerState clone on
// every change (each volume step, each like…), so `current`, `currentAnalysis` and `queue`
// change identity constantly. These hooks only update when something we render changed, which
// keeps the Play screen / queue from re-rendering (and the seek graph from re-rasterising) on
// unrelated pushes.
import { useEffect, useState } from 'react'
import type { QueueItem, TrackAnalysis, TrackView } from '@shared/types'
import { usePlayer } from '../../state/player'

function sameTrack(a: TrackView | null, b: TrackView | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.liked === b.liked &&
    a.downloaded === b.downloaded &&
    a.title === b.title &&
    a.cover === b.cover &&
    a.hero === b.hero &&
    a.accent === b.accent &&
    a.gameName === b.gameName &&
    a.source?.provider === b.source?.provider &&
    a.source?.format === b.source?.format &&
    a.analysis?.intensity === b.analysis?.intensity &&
    a.analysis?.bpm === b.analysis?.bpm
  )
}

function sameAnalysis(a: TrackAnalysis | null, b: TrackAnalysis | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.bpm === b.bpm &&
    a.intensity === b.intensity &&
    a.energy.length === b.energy.length &&
    a.beats.length === b.beats.length &&
    a.kiai.length === b.kiai.length &&
    a.energy[0] === b.energy[0] &&
    a.energy[a.energy.length >> 1] === b.energy[b.energy.length >> 1] &&
    a.beats[0] === b.beats[0] &&
    (a.kiai[0]?.[0] ?? -1) === (b.kiai[0]?.[0] ?? -1)
  )
}

function sameQueue(a: QueueItem[], b: QueueItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].uid !== b[i].uid || a[i].track.liked !== b[i].track.liked) return false
  return true
}

function useStable<T>(select: () => T, same: (a: T, b: T) => boolean): T {
  const [v, setV] = useState(select)
  useEffect(() => {
    setV((prev) => {
      const next = select()
      return same(prev, next) ? prev : next
    })
    return usePlayer.subscribe(() =>
      setV((prev) => {
        const next = select()
        return same(prev, next) ? prev : next
      })
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return v
}

/** The current track, updating only when a rendered field changes. */
export function useCurrentTrack(): TrackView | null {
  return useStable(() => usePlayer.getState().current, sameTrack)
}

/** The current track's offline analysis, updating only when it really changes. */
export function useCurrentAnalysis(): TrackAnalysis | null {
  return useStable(() => usePlayer.getState().currentAnalysis, sameAnalysis)
}

/** The queue, updating only when its order/membership (or a like) changes. */
export function useStableQueue(): QueueItem[] {
  return useStable(() => usePlayer.getState().queue, sameQueue)
}
