import { describe, expect, it } from 'vitest'
import { allVoices, formatVoiceMask, isMuted, MAX_VOICES, parseVoiceMask, voiceBit } from './voices'

describe('voice masks', () => {
  it('address every one of 64 voices exactly', () => {
    // voice 32 is no sign bit, voice 33 no wrap back to voice 1, voice 64 no rounding
    expect(voiceBit(31)).toBe(2n ** 31n)
    expect(voiceBit(32)).toBe(2n ** 32n)
    expect(voiceBit(63)).toBe(2n ** 63n)
    expect(isMuted(voiceBit(32), 0)).toBe(false)
    expect(isMuted(voiceBit(32), 32)).toBe(true)
    expect(allVoices(MAX_VOICES)).toBe(2n ** 64n - 1n)
    expect(allVoices(5)).toBe(0b11111n)
    expect(allVoices(0)).toBe(0n)
    expect(allVoices(100)).toBe(allVoices(64))
    // solo voice 33 of 64: the other 63 muted, voice 64 too
    const solo = allVoices(64) & ~voiceBit(32)
    expect(Array.from({ length: 64 }, (_, i) => isMuted(solo, i)).filter(Boolean)).toHaveLength(63)
    expect(isMuted(solo, 63)).toBe(true)
  })

  it('travel as hex, and only real masks parse', () => {
    for (const m of [0n, 1n, voiceBit(31), voiceBit(32), allVoices(64) & ~voiceBit(32), allVoices(64)]) expect(parseVoiceMask(formatVoiceMask(m))).toBe(m)
    expect(formatVoiceMask(0n)).toBe('0')
    expect(formatVoiceMask(allVoices(64))).toBe('ffffffffffffffff')
    expect(parseVoiceMask('FF')).toBe(255n)
    for (const bad of ['', '-1', '0x1', '1'.repeat(17), 'nope', 3, 2n, null, undefined]) expect(parseVoiceMask(bad), String(bad)).toBeNull()
  })
})
