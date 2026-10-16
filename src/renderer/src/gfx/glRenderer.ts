// The app's WebGL renderers (background, visualizers) are made here, not by autoDetectRenderer:
//  · no depth or stencil buffer: nothing in GHOST uses Pixi masks, filters or Graphics, and each
//    buffer costs 4 bytes per drawing-buffer pixel (~12 MB for the full-window visualizer stage);
//  · no throwaway probe context: autoDetectRenderer's isWebGLSupported() creates a WebGL context
//    and loses it again before making the real one, a synchronous GPU-process round trip each.
// Without WebGL 2 it falls back to autoDetectRenderer, which picks whatever this machine has.
import { autoDetectRenderer, WebGLRenderer, type Renderer, type WebGLOptions } from 'pixi.js'

export async function createGlRenderer(options: Partial<WebGLOptions>): Promise<Renderer> {
  const canvas = document.createElement('canvas')
  const transparent = (options.backgroundAlpha ?? 1) < 1
  const gl = canvas.getContext('webgl2', {
    alpha: transparent,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: options.powerPreference ?? 'default'
  })
  if (!gl) return autoDetectRenderer({ ...options, preference: 'webgl' })
  const renderer = new WebGLRenderer()
  await renderer.init({ ...options, canvas, context: gl })
  return renderer
}
