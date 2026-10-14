// Tiny beat-reactive equaliser (4 bars) for the current queue item. Bars are driven per frame
// from the smoothed audio levels plus the beat pulse (scaleY only, compositor-friendly).
import { useEffect, useRef } from 'react'
import { beat } from '../../motion/beat'
import { levels, retainLevels } from '../../motion/frame'
import { motionPrefs } from '../../motion/prefs'
import { ticker } from '../../motion/ticker'
import { usePlayer } from '../../state/player'
import { cx } from '../../ui/util'

export function MiniEq({ active = true, className }: { active?: boolean; className?: string }) {
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el || !active) return
    const bars = Array.from(el.children) as HTMLElement[]
    const releaseLevels = retainLevels()
    const releaseBeat = beat.retain()
    const cur = [0.3, 0.3, 0.3, 0.3]
    const last = ['', '', '', '']
    const off = ticker.add((dt, now) => {
      const playing = usePlayer.getState().status === 'playing'
      const t = now / 1000
      const p = motionPrefs.reduce ? 0 : beat.pulse
      const targets = playing
        ? [levels.bass * 1.1 + p * 0.25, levels.mid * 1.5 + p * 0.12, levels.high * 1.3 + 0.1 * Math.sin(t * 9), levels.level * 1.2 + p * 0.18]
        : [0.18, 0.18, 0.18, 0.18]
      for (let i = 0; i < 4; i++) {
        const target = Math.max(0.16, Math.min(1, targets[i] + (playing ? 0.12 * Math.sin(t * (5 + i * 1.7) + i) : 0)))
        cur[i] += (target - cur[i]) * (1 - Math.exp(-dt / (target > cur[i] ? 35 : 120)))
        const v = `scaleY(${cur[i].toFixed(3)})`
        if (v !== last[i]) bars[i].style.transform = last[i] = v
      }
    })
    return () => {
      off()
      releaseLevels()
      releaseBeat()
    }
  }, [active])
  return (
    <span ref={root} className={cx('np-eq', className)} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
