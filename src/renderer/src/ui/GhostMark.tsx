// The GHOST mark: a friendly ghost wearing headphones. Monochrome (currentColor) for
// toolbars, empty states and fallbacks. The full title-screen logo lives in screens/title.
import type { SVGProps } from 'react'

export const GHOST_BODY_PATH =
  'M0 -40 C23 -40 39 -24 39 -1 L39 30 C39 39 33.5 44 27 44 C21 44 19.5 36 13 36 C6.5 36 5.5 46 -1 46 C-7.5 46 -9 36 -15 36 C-21 36 -22.5 45 -30 45 C-36 45 -39 39.5 -39 33 L-39 -1 C-39 -24 -23 -40 0 -40 Z'

export interface GhostMarkProps extends SVGProps<SVGSVGElement> {
  size?: number
  /** Draw the headphones. Default true. */
  headphones?: boolean
}

export function GhostMark({ size = 22, headphones = true, ...rest }: GhostMarkProps) {
  return (
    <svg width={size} height={size} viewBox="-56 -56 112 112" aria-hidden {...rest}>
      <path d={GHOST_BODY_PATH} fill="currentColor" />
      <ellipse cx="-13" cy="-4" rx="6" ry="8.5" fill="var(--ghost-eyes, #0f0d17)" />
      <ellipse cx="13" cy="-4" rx="6" ry="8.5" fill="var(--ghost-eyes, #0f0d17)" />
      {headphones && (
        <>
          <path d="M-44 -2 C-44 -36 -24 -52 0 -52 C24 -52 44 -36 44 -2" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
          <rect x="-53" y="-12" width="15" height="26" rx="6.5" fill="currentColor" />
          <rect x="38" y="-12" width="15" height="26" rx="6.5" fill="currentColor" />
        </>
      )}
    </svg>
  )
}
