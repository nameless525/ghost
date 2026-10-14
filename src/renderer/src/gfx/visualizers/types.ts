import type { Container } from 'pixi.js'
import type { AnalysisFrame } from '@shared/types'
import type { BeatEvent } from '../../motion/beat'

export type VisualizerMode = 'radial' | 'skyline' | 'scope'
export const VISUALIZER_MODES: VisualizerMode[] = ['radial', 'skyline', 'scope']
export const VISUALIZER_LABELS: Record<VisualizerMode, string> = { radial: 'Radial', skyline: 'Skyline', scope: 'Oscilloscope' }

/** Everything a layer needs for one frame (shared, mutated in place by the stage). */
export interface VisFrame {
  dt: number
  now: number
  frame: AnalysisFrame | null
  playing: boolean
  /** Beat envelope, 0..~1.6. */
  pulse: number
  /** Smoothed kiai blend, 0..1. */
  kiai: number
  /** 0..1 through the current beat. */
  phase: number
  level: number
  bass: number
  high: number
  reduce: boolean
  /** Live accent with saturation pushed up during kiai (0xRRGGBB). */
  accent: number
  /** Lighter accent for cores and highlights. */
  accentHi: number
  /** Deeper accent for gradients/far trails. */
  accentLo: number
  /** Near-white faintly tinted towards the accent. */
  white: number
  /** Extra drive during kiai, 1..~1.3. */
  drive: number
}

export interface VisLayout {
  w: number
  h: number
  /** Radial centre and cover radius (css px), shared with the DOM disc. */
  cx: number
  cy: number
  radius: number
  /** Skyline baseline y. */
  baseline: number
  /** Oscilloscope centre line y. */
  scopeY: number
}

export interface EmitPoint {
  x: number
  y: number
  dx: number
  dy: number
}

export interface VisLayer {
  readonly root: Container
  layout(l: VisLayout): void
  /** @param mix 0..1 presence of this mode (eased by the stage). */
  update(f: VisFrame, mix: number): void
  onBeat?(e: BeatEvent, f: VisFrame): void
  /** Spawn point i of n for the kiai particle burst. */
  emitter(i: number, n: number, out: EmitPoint): void
  destroy(): void
}

/**
 * Where the radial disc sits for a window size. The Play screen positions its DOM cover with
 * the same numbers, so the GPU ring hugs it exactly.
 */
export function radialGeometry(w: number, h: number): { cx: number; cy: number; radius: number } {
  const radius = Math.round(Math.max(64, Math.min(h * 0.165, w * (w < 1000 ? 0.15 : 0.12), 190)))
  return { cx: Math.round(w / 2), cy: Math.round(h * 0.44), radius }
}

/** Height (css px) reserved for the Play HUD at the bottom of the window. */
export const HUD_HEIGHT = 168

/** @param bottomInset height of the HUD covering the bottom of the stage (css px). */
export function computeLayout(w: number, h: number, bottomInset = HUD_HEIGHT): VisLayout {
  const g = radialGeometry(w, h)
  return { w, h, ...g, baseline: Math.round(h - Math.max(60, Math.min(h * 0.45, bottomInset)) - 8), scopeY: Math.round(h * 0.44) }
}
