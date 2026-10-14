// Play-screen visualizers (radial ring, skyline, oscilloscope) on a dedicated PixiJS canvas.
//
//   const stage = getVisualizerStage()
//   stage.attach(hostDiv)            // canvas fills the host; ticks while attached
//   stage.setMode('scope')           // animated cross-transition
//   stage.setPresence(1)             // 0 hides everything (e.g. under the title card)
//   stage.detach(hostDiv)
export { getVisualizerStage, VisualizerStage } from './stage'
export { computeLayout, radialGeometry, HUD_HEIGHT, VISUALIZER_LABELS, VISUALIZER_MODES } from './types'
export type { VisLayout, VisualizerMode } from './types'
export { RADIAL_PULSE } from './radial'
