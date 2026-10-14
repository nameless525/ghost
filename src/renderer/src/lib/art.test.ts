import { describe, expect, it } from 'vitest'
import { ART_BUCKETS, artBucket } from './art'

describe('artBucket', () => {
  it('rounds the device-pixel width up to a cached bucket', () => {
    expect(artBucket(36, 2)).toBe(128) // list thumbnail on Retina
    expect(artBucket(64, 2)).toBe(128)
    expect(artBucket(65, 2)).toBe(256)
    expect(artBucket(200, 2)).toBe(512) // carousel group art
    expect(artBucket(300, 2)).toBe(768) // play disc cover
    expect(artBucket(460, 2)).toBe(1024) // now-playing hero
    expect(artBucket(512, 1)).toBe(512) // blur source (device px)
  })

  it('caps at the largest bucket', () => {
    expect(artBucket(5000, 2)).toBe(ART_BUCKETS[ART_BUCKETS.length - 1])
  })

  it('shares one URL between nearby sizes', () => {
    expect(new Set([40, 48, 56, 64].map((w) => artBucket(w, 2))).size).toBe(1)
  })
})
