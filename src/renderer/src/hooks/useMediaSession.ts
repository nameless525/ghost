// OS media integration through Chromium: macOS Now Playing, Windows SMTC, Linux MPRIS.
//
// Chromium only publishes a media session for a page that is actually playing media, but our
// audio comes from the native engine. So we keep a tiny looping, digitally-silent <audio>
// (a generated WAV blob) playing while the player plays, and drive navigator.mediaSession:
// metadata (title / game / album / artwork), playback state, position, and the transport
// actions, which call ghost().player.*.
import { useEffect } from 'react'
import type { PlayerState } from '@shared/types'
import { ghost } from '../ghost'
import { artUrl } from '../lib/art'
import { livePositionMs, usePlayer } from '../state/player'

/** 8-bit mono PCM WAV of pure silence. Longer than 5 s so Chromium treats it as real media. */
function silentWavUrl(seconds = 8, rate = 8000): string {
  const n = seconds * rate
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + n, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate, true) // byte rate
  v.setUint16(32, 1, true) // block align
  v.setUint16(34, 8, true) // bits
  str(36, 'data')
  v.setUint32(40, n, true)
  new Uint8Array(buf, 44).fill(128) // unsigned 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

const isPlayingish = (s: PlayerState) => !!s.current && (s.status === 'playing' || s.status === 'loading' || s.status === 'buffering')

export function useMediaSession(): void {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const url = silentWavUrl()
    const audio = new Audio(url)
    audio.loop = true
    audio.preload = 'auto'
    let want = false
    let blocked = false

    const sync = () => {
      if (want && audio.paused) {
        audio.play().then(
          () => (blocked = false),
          () => (blocked = true) // autoplay policy: retried on the next user gesture
        )
      } else if (!want && !audio.paused) audio.pause()
    }
    const onGesture = () => {
      if (blocked) sync()
    }
    window.addEventListener('pointerdown', onGesture, true)
    window.addEventListener('keydown', onGesture, true)

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void ghost().player.play()],
      ['pause', () => void ghost().player.pause()],
      ['stop', () => void ghost().player.pause()],
      ['nexttrack', () => void ghost().player.next()],
      ['previoustrack', () => void ghost().player.prev()],
      ['seekto', (d) => d.seekTime != null && void ghost().player.seek(d.seekTime * 1000)],
      ['seekbackward', (d) => void ghost().player.seek(Math.max(0, livePositionMs() - (d.seekOffset ?? 10) * 1000))],
      ['seekforward', (d) => void ghost().player.seek(livePositionMs() + (d.seekOffset ?? 10) * 1000)]
    ]
    for (const [a, h] of handlers) {
      try {
        ms.setActionHandler(a, h)
      } catch {
        /* unsupported action on this platform */
      }
    }

    let lastMetaKey = ''
    const apply = (s: PlayerState) => {
      want = isPlayingish(s)
      sync()
      const t = s.current
      ms.playbackState = !t ? 'none' : s.status === 'paused' || s.status === 'idle' || s.status === 'error' ? 'paused' : 'playing'
      const key = t ? `${t.id}|${t.cover}` : ''
      if (key !== lastMetaKey) {
        lastMetaKey = key
        try {
          const art = artUrl(t?.cover, { w: 512, dpr: 1 })
          ms.metadata = t
            ? new MediaMetadata({
                title: t.title,
                artist: t.gameName ?? t.composers.join(', '),
                album: t.albumTitle,
                artwork: art ? [{ src: art, sizes: '512x512' }] : []
              })
            : null
        } catch (err) {
          console.warn('[media-session] metadata', err)
        }
      }
      if (t && s.durationMs && s.durationMs > 0) {
        try {
          const dur = s.durationMs / 1000
          ms.setPositionState({ duration: dur, playbackRate: 1, position: Math.min(dur, Math.max(0, livePositionMs(s) / 1000)) })
        } catch {
          /* position > duration races */
        }
      }
    }
    apply(usePlayer.getState())
    const unsub = usePlayer.subscribe(apply)

    return () => {
      unsub()
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
      for (const [a] of handlers) {
        try {
          ms.setActionHandler(a, null)
        } catch {
          /* ignore */
        }
      }
      audio.pause()
      audio.removeAttribute('src')
      URL.revokeObjectURL(url)
      ms.metadata = null
      ms.playbackState = 'none'
    }
  }, [])
}
