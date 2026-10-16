// Play screen "Channels" strip: one sheared pill per sound-chip voice of the playing chiptune
// ("Square 1", "Triangle", "Noise", "DMC"). Click mutes / unmutes; Alt(⌥)-click solos (again to
// un-solo); 1–9 toggle the matching voice, Alt+1–9 solo it, 0 brings every voice back.
// Lives above the HUD's right side and fades with it.
import { Cpu, Headphones, RotateCcw, VolumeX } from 'lucide-react'
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { allVoices, formatVoiceMask, isMuted, parseVoiceMask, voiceBit } from '@shared/voices'
import { ghost } from '../../ghost'
import { usePulse } from '../../motion/hooks'
import { stagger, tween } from '../../motion/tween'
import { useKeybinding } from '../../shell/keys'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { isMac } from '../../theme'
import { Tooltip } from '../../ui'
import { cx } from '../../ui/util'
import { PendingMask } from './pending-mask'

const MAX_KEYS = 9

export interface ChannelStripProps {
  /** On-screen confirmation for keyboard changes (the Play screen's OSD). */
  onAnnounce?: (o: { icon: ReactNode; label: string; value: string }) => void
}

/** "⌥-click" on macOS, "Alt+click" elsewhere. */
const ALT_CLICK = isMac ? '⌥-click' : 'Alt+click'

export function ChannelStrip({ onAnnounce }: ChannelStripProps) {
  const voices = usePlayer((s) => s.voices)
  const trackId = usePlayer((s) => s.current?.id ?? null)
  // Optimistic mask: the pill answers the click at once, main's answer to the request settles it.
  const [pending] = useState(() => new PendingMask())
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const root = useRef<HTMLDivElement>(null)
  const slots = useRef<(HTMLDivElement | null)[]>([])
  const names = voices?.names ?? []
  const mask = pending.mask ?? parseVoiceMask(voices?.mask) ?? 0n
  const all = allVoices(names.length)
  const soloed = names.length > 1 && names.findIndex((_, i) => mask === (all & ~voiceBit(i)))

  useEffect(() => {
    if (pending.reset()) redraw()
  }, [trackId, pending])
  usePulse(root, { mode: 'var', enabled: !!voices })

  // A new set of voices (or a new track) staggers the pills in from the right.
  const key = `${trackId}\u0000${names.join('\u0001')}`
  useLayoutEffect(() => {
    const els = slots.current.slice(0, names.length).filter(Boolean) as HTMLElement[]
    if (!els.length) return
    for (const el of els) tween(el).clear().set({ opacity: 0, x: 22 })
    void stagger(els.slice().reverse(), (t) => t.delay(80).fadeIn(260, 'outQuad').moveToX(0, 620, 'outQuint'), 32)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (next: bigint) => {
    const ticket = pending.send(next)
    redraw()
    void ghost()
      .player.setVoiceMask(formatVoiceMask(next))
      .finally(() => {
        if (pending.answered(ticket)) redraw()
      })
  }
  const bump = (i: number) => {
    const el = slots.current[i]
    if (el) tween(el).clear().set({ opacity: 1, x: 0 }).scaleTo(0.92, 70, 'outQuad').then().scaleTo(1, 520, 'outElasticHalf')
  }

  const toggle = (i: number, announce = false) => {
    if (i >= names.length) return
    const muting = !isMuted(mask, i)
    const next = mask ^ voiceBit(i)
    sfx.play(muting ? 'toggleOff' : 'toggleOn', { volume: 0.55 })
    bump(i)
    apply(next)
    if (announce) onAnnounce?.({ icon: muting ? <VolumeX /> : <Cpu />, label: names[i], value: muting ? 'Muted' : 'On' })
  }
  const solo = (i: number, announce = false) => {
    if (i >= names.length || names.length < 2) return
    const only = all & ~voiceBit(i)
    const off = mask === only
    sfx.play(off ? 'collapse' : 'expand', { volume: 0.5 })
    bump(i)
    apply(off ? 0n : only)
    if (announce) onAnnounce?.({ icon: <Headphones />, label: names[i], value: off ? 'Solo off' : 'Solo' })
  }
  const reset = (announce = false) => {
    if (mask === 0n) return
    sfx.play('toggleOn', { volume: 0.5 })
    apply(0n)
    if (announce) onAnnounce?.({ icon: <Cpu />, label: 'Channels', value: 'All on' })
  }

  const enabled = names.length > 0
  for (let k = 1; k <= MAX_KEYS; k++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed count, stable order
    useKeybinding(String(k), () => toggle(k - 1, true), { repeat: false, enabled: enabled && k <= names.length })
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKeybinding(`Alt+${k}`, () => solo(k - 1, true), { repeat: false, enabled: enabled && k <= names.length && names.length > 1 })
  }
  useKeybinding('0', () => reset(true), { repeat: false, enabled: enabled && mask !== 0n })

  if (!voices || !names.length) return null
  const muted = names.filter((_, i) => isMuted(mask, i)).length
  const onClick = (i: number) => (e: MouseEvent) => (e.altKey ? solo(i) : toggle(i))

  return (
    <div ref={root} className="pl-ch" role="group" aria-label="Sound-chip channels">
      <div className="pl-ch__head">
        <Cpu size={13} strokeWidth={2.4} />
        <span className="g-caps">Channels</span>
        <span className="pl-ch__count tnum">{muted ? `${names.length - muted}/${names.length}` : names.length}</span>
        <button type="button" className={cx('pl-ch__reset', mask !== 0n && 'pl-ch__reset--on')} tabIndex={mask !== 0n ? 0 : -1} aria-hidden={mask === 0n} onClick={() => reset()} onPointerEnter={() => mask !== 0n && sfx.play('hover')}>
          <RotateCcw size={11} strokeWidth={2.6} />
          All on
        </button>
      </div>
      <div className="pl-ch__pills">
        {names.map((name, i) => {
          const off = isMuted(mask, i)
          const isSolo = soloed === i
          return (
            <div
              key={`${i}:${name}`}
              ref={(el) => {
                slots.current[i] = el
              }}
              className="pl-ch__slot"
            >
              <Tooltip
                content={isSolo ? `Solo · ${ALT_CLICK} to bring the others back` : off ? `Muted · click to unmute, ${ALT_CLICK} to solo` : `Click to mute · ${ALT_CLICK} to solo`}
                shortcut={i < MAX_KEYS ? String(i + 1) : undefined}
                side="top"
              >
                <button
                  type="button"
                  className={cx('pl-ch__pill', off && 'pl-ch__pill--off', isSolo && 'pl-ch__pill--solo')}
                  aria-pressed={!off}
                  aria-label={`${name}${off ? ' (muted)' : ''}`}
                  onClick={onClick(i)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    solo(i)
                  }}
                  onPointerEnter={() => sfx.play('hover', { volume: 0.5 })}
                >
                  <span className="pl-ch__bar" aria-hidden />
                  <span className="pl-ch__wash" aria-hidden />
                  <span className="pl-ch__content">
                    {i < MAX_KEYS && <span className="pl-ch__key tnum">{i + 1}</span>}
                    <span className="pl-ch__name">{name}</span>
                    {isSolo ? <Headphones className="pl-ch__icon" size={12} strokeWidth={2.6} /> : off ? <VolumeX className="pl-ch__icon" size={12} strokeWidth={2.6} /> : <span className="pl-ch__led" aria-hidden />}
                  </span>
                </button>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
