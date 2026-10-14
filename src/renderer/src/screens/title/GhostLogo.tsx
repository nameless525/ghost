// The GHOST logo: a vinyl record with a white outer ring, rotating label text, an accent
// label, and a friendly headphone-wearing ghost floating on top (it blinks). Layered DOM so
// only the text ring rotates (a cheap compositor transform) while the ghost stays upright.
import { forwardRef, useEffect, useRef, type Ref } from 'react'
import { GHOST_BODY_PATH } from '../../ui/GhostMark'

// SVG text collapses runs of spaces and trims the trailing one, which jammed the last ✦ against
// "GAME" where the ring closes: single spaces, and a no-break space for the seam.
const RING_TEXT = 'GAME HAVEN OST ✦ STREAM ANY SOUNDTRACK ✦\u00a0'

export interface GhostLogoProps {
  /** Receives the rotating text ring (rotate it while playing). */
  spinRef?: Ref<HTMLDivElement>
  /** Receives the glow layer (drive its --pulse). */
  glowRef?: Ref<HTMLDivElement>
}

export const GhostLogo = forwardRef<HTMLDivElement, GhostLogoProps>(function GhostLogo({ spinRef, glowRef }, ref) {
  const eyes = useRef<SVGGElement>(null)

  // blink every few seconds
  useEffect(() => {
    let t = 0
    const schedule = () => {
      t = window.setTimeout(() => {
        const g = eyes.current
        if (g) {
          g.classList.remove('tl-eyes--blink')
          void g.getBoundingClientRect()
          g.classList.add('tl-eyes--blink')
        }
        schedule()
      }, 2800 + Math.random() * 4200)
    }
    schedule()
    return () => window.clearTimeout(t)
  }, [])

  return (
    <div ref={ref} className="tl-logo-art">
      <div ref={glowRef} className="tl-logo-art__glow" />
      <div className="tl-logo-art__disc" />
      <div ref={spinRef} className="tl-logo-art__spin">
        <svg viewBox="-100 -100 200 200" aria-hidden>
          <defs>
            <path id="tl-ring-path" d="M 0,-75.5 a 75.5,75.5 0 1,1 0,151 a 75.5,75.5 0 1,1 0,-151" />
          </defs>
          <circle r="89.5" fill="none" stroke="rgb(255 255 255 / 0.22)" strokeWidth="2.2" strokeDasharray="0.9 8.47" />
          <circle r="66" fill="none" stroke="var(--accent-hi)" strokeOpacity="0.55" strokeWidth="0.9" strokeDasharray="70 18 6 18" strokeLinecap="round" />
          <text className="tl-ring-text">
            <textPath href="#tl-ring-path" textLength={2 * Math.PI * 75.5 - 2} lengthAdjust="spacing">
              {RING_TEXT}
            </textPath>
          </text>
        </svg>
      </div>
      <div className="tl-logo-art__label" />
      <div className="tl-logo-art__ghost">
        <svg viewBox="-60 -62 120 120" aria-hidden>
          <defs>
            <linearGradient id="tl-ghost-body" x1="0" y1="-40" x2="0" y2="46" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="1" stopColor="#ece6ff" />
            </linearGradient>
          </defs>
          <path d={GHOST_BODY_PATH} fill="url(#tl-ghost-body)" />
          {/* soft shading on the right flank */}
          <path d="M22 -33 C33 -24 39 -13 39 -1 L39 30 C39 39 33.5 44 27 44 C31 34 32 14 30 -4 C29 -16 26 -26 22 -33 Z" fill="#cfc4f2" opacity="0.45" />
          <g ref={eyes} className="tl-eyes">
            <ellipse cx="-13" cy="-4" rx="6" ry="8.5" fill="#1a1226" />
            <ellipse cx="13" cy="-4" rx="6" ry="8.5" fill="#1a1226" />
            <circle cx="-10.6" cy="-7.6" r="2.1" fill="#fff" />
            <circle cx="15.4" cy="-7.6" r="2.1" fill="#fff" />
          </g>
          <ellipse cx="-24" cy="9.5" rx="6.2" ry="3.4" fill="var(--accent)" opacity="0.5" />
          <ellipse cx="24" cy="9.5" rx="6.2" ry="3.4" fill="var(--accent)" opacity="0.5" />
          <path d="M-4.5 10.5 Q0 14.5 4.5 10.5" fill="none" stroke="#1a1226" strokeWidth="2.4" strokeLinecap="round" />
          {/* headphones */}
          <path d="M-44.5 -2 C-44.5 -37 -24 -53 0 -53 C24 -53 44.5 -37 44.5 -2" fill="none" stroke="#1d1529" strokeWidth="7.5" strokeLinecap="round" />
          <path d="M-38 -26 C-31 -42 -16 -48.5 0 -48.5" fill="none" stroke="#ffffff" strokeOpacity="0.28" strokeWidth="2" strokeLinecap="round" />
          <rect x="-54" y="-13" width="16" height="27" rx="7" fill="#1d1529" />
          <rect x="38" y="-13" width="16" height="27" rx="7" fill="#1d1529" />
          <rect x="-50.5" y="-8" width="6" height="17" rx="3" fill="var(--accent)" />
          <rect x="44.5" y="-8" width="6" height="17" rx="3" fill="var(--accent)" />
        </svg>
      </div>
      <div className="tl-logo-art__ring" />
    </div>
  )
})
