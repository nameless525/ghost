// Sound-chip voice masks (PlayerState.voices.mask, player.setVoiceMask): bit i set = voice i
// muted. Trackers have up to 64 voices, past a number's exact integers and its 32-bit bitwise
// operators, so a mask is a bigint in code and lowercase hex on the wire (it stays JSON-safe for
// logs and devtools, where a bigint throws).
import type { VoiceMask } from './types'

/** Voices a mask can address: the engine's mask is a u64. */
export const MAX_VOICES = 64

/** Every voice on. */
export const VOICES_ALL_ON: VoiceMask = '0'

/** The bit of voice `i` (0-based). */
export const voiceBit = (i: number): bigint => 1n << BigInt(i)

/** Every one of `n` voices muted. */
export const allVoices = (n: number): bigint => (1n << BigInt(Math.max(0, Math.min(MAX_VOICES, Math.floor(n) || 0)))) - 1n

/** A wire mask as a bigint; null when it isn't one (not hex, or wider than MAX_VOICES bits). */
export function parseVoiceMask(mask: unknown): bigint | null {
  return typeof mask === 'string' && /^[0-9a-f]{1,16}$/i.test(mask) ? BigInt(`0x${mask}`) : null
}

export const formatVoiceMask = (mask: bigint): VoiceMask => mask.toString(16)

/** Whether voice `i` is muted in `mask`. */
export const isMuted = (mask: bigint, i: number): boolean => (mask & voiceBit(i)) !== 0n
