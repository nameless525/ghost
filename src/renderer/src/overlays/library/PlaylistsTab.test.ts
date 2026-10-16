import { describe, expect, it } from 'vitest'
import type { Playlist } from '@shared/types'
import { shownPlaylists } from './PlaylistsTab'

const pl = (name: string, updatedAt: number): Playlist => ({
  id: name,
  name,
  description: null,
  kind: 'manual',
  query: null,
  trackCount: 1,
  durationMs: 1000,
  covers: [],
  createdAt: 0,
  updatedAt
})

const six = [pl('Boss Rush', 6), pl('Final Boss', 5), pl('Towns', 4), pl('Rain', 3), pl('Overworld', 2), pl('Credits', 1)]
const names = (list: Playlist[]) => list.map((p) => p.name)

describe('shownPlaylists', () => {
  it('filters while the field is there', () => {
    expect(names(shownPlaylists(six, 'boss', 'recent'))).toEqual(['Boss Rush', 'Final Boss'])
  })

  it('shows every playlist again once deleting down to five hides the field', () => {
    const five = six.filter((p) => p.name !== 'Boss Rush')
    expect(names(shownPlaylists(five, 'boss', 'recent'))).toEqual(['Final Boss', 'Towns', 'Rain', 'Overworld', 'Credits'])
  })

  it('sorts, filtered or not', () => {
    expect(names(shownPlaylists(six, '', 'name'))).toEqual(['Boss Rush', 'Credits', 'Final Boss', 'Overworld', 'Rain', 'Towns'])
    expect(names(shownPlaylists(six.slice(0, 3), 'zzz', 'name'))).toEqual(['Boss Rush', 'Final Boss', 'Towns'])
  })
})
