// Pushes engine-related settings into the audio engine. Called once at startup (prev = null)
// and on every settings change (only the values that changed are re-applied).
import type { EngineBridge } from '../engine/types'
import type { Settings } from '../../shared/types'

/** Loop parameters for the engine. 'album' is the game-rip convention: 2 loops then a 10 s fade. */
export function loopParams(a: Settings['audio']): [Settings['audio']['loopMode'], number, number] {
  switch (a.loopMode) {
    case 'album':
      return ['album', 2, 10]
    case 'endless':
      return ['endless', 0, a.fadeSec]
    default:
      return ['custom', a.loopCount, a.fadeSec]
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function applyEngineSettings(engine: EngineBridge, next: Settings, prev: Settings | null): void {
  const a = next.audio
  const p = prev?.audio
  const run = (what: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      console.error(`[settings] engine.${what} failed:`, e)
    }
  }
  if (!p || !same(a.normalization, p.normalization)) {
    run('setNormalization', () => engine.setNormalization(a.normalization.enabled, a.normalization.targetLufs, a.normalization.mode))
  }
  if (!p || a.gapless !== p.gapless) run('setGapless', () => engine.setGapless(a.gapless))
  if (!p || a.crossfadeSec !== p.crossfadeSec) run('setCrossfade', () => engine.setCrossfade(a.crossfadeSec))
  if (!p || !same(loopParams(a), loopParams(p))) {
    const [mode, count, fade] = loopParams(a)
    run('setLoop', () => engine.setLoop(mode, count, fade))
  }
  if (!p ? a.device !== 'default' : a.device !== p.device) {
    run('setDevice', () => engine.setDevice(a.device === 'default' ? null : a.device))
  }
}
