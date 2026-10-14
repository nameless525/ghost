// Keeps the theme in step with playback: whenever the CURRENT TRACK changes, the accent moves
// to the track's game colour and (unless Browse is showing — Browse owns its background while
// active) the background art moves to the track's hero art.
import { useEffect } from 'react'
import type { PlayerState } from '@shared/types'
import { usePlayer } from '../state/player'
import { DEFAULT_ACCENT, useUI } from '../state/ui'

/** Background art for a track: its game's hero art, else its cover. */
export const trackArt = (t: PlayerState['current']): string | null => t?.hero ?? t?.cover ?? null

export function usePlayerThemeSync(): void {
  useEffect(() => {
    let lastId: string | null | undefined
    const apply = (s: PlayerState) => {
      const id = s.current?.id ?? null
      if (id === lastId) return
      lastId = id
      if (!s.current) return
      const ui = useUI.getState()
      ui.setAccent(s.current.accent ?? DEFAULT_ACCENT)
      if (ui.screen !== 'browse') ui.setBackground(trackArt(s.current))
    }
    apply(usePlayer.getState())
    return usePlayer.subscribe(apply)
  }, [])
}

/**
 * For screens that show the now-playing art (Title, Play): apply the current track's art when
 * the screen mounts, with the given dim/blur, and keep following it.
 */
export function useNowPlayingBackground(opts: { dim?: number; blur?: number } = {}): void {
  const art = usePlayer((s) => trackArt(s.current))
  const { dim, blur } = opts
  useEffect(() => {
    useUI.getState().setBackground(art, { dim, blur })
  }, [art, dim, blur])
}
