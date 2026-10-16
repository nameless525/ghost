import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlbumDetail, BrowsePage } from '@shared/types'
import { trackActions } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import { notify } from '../../shell/notifications'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { cancelPendingPreview, cancelPlay, playResult, playSelection, previewFollowSelection, restingAlbum, startPreview, togglePreview } from './actions'
import { browseModel } from './model'
import { useBrowse } from './store'
import { album, deferred, detail, flush, group, installGhost, pagesOf, selOf } from './testing'

vi.mock('../../lib/track-actions', () => ({ trackActions: { playAlbum: vi.fn(async () => {}) }, playlistSubmenu: () => [] }))
vi.mock('../../shell/navigation', () => ({ navigate: vi.fn() }))
vi.mock('../../shell/notifications', () => ({ notify: vi.fn(), useNotifications: { getState: () => ({ dismiss: () => {} }) } }))
vi.mock('../../sound', () => ({ sfx: { play: () => {} } }))
vi.mock('../../ui/ContextMenu', () => ({ openContextMenu: () => {} }))

const playAlbum = vi.mocked(trackActions.playAlbum)

let ghost: ReturnType<typeof installGhost>
let run = 0
beforeEach(async () => {
  ghost = installGhost()
  vi.clearAllMocks()
  useSettings.setState({ audio: { ...useSettings.getState().audio, previewOnSelect: true } })
  usePlayer.setState({ status: 'paused', preview: null })
  // each test starts from results of its own (the model is Browse's one instance)
  ghost.api.catalog.browse.mockImplementation(pagesOf(() => ['game:a', 'game:b']))
  useBrowse.setState({ text: `run ${++run}`, sel: null, externalAuto: null })
  await browseModel.setQuery({ text: `run ${run}`, group: 'game', sort: 'title' })
})
afterEach(() => {
  cancelPlay()
  cancelPendingPreview()
  vi.unstubAllGlobals()
})

/** An album row selected, its track list not loaded yet. */
const albumSel = (id: string) => selOf(group('game:x'), { id: `0|game:x|${id}|`, kind: 'album', album: album(id) })

describe('Enter in the search box', () => {
  it('waits for the typed query’s results and plays the result once, never the previous selection', async () => {
    useBrowse.setState({ sel: albumSel(`old-${run}`) })
    // "beta" typed and Enter pressed at once: its results are on their way
    const page = deferred<BrowsePage>()
    ghost.api.catalog.browse.mockReturnValueOnce(page.promise)
    useBrowse.setState({ text: 'beta' })
    const done = playResult(true)
    await flush()
    expect(playAlbum).not.toHaveBeenCalled()

    // they arrive and the carousel selects the first of them
    const off = browseModel.subscribe((e) => e.type === 'page' && useBrowse.setState({ sel: albumSel(`new-${run}`) }))
    page.resolve({ total: 1, offset: 0, groups: [group('game:beta')] })
    await done
    off()
    expect(playAlbum.mock.calls).toEqual([[`new-${run}`, 0]])
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(useBrowse.getState().externalAuto).toBeNull()
  })

  it('searches online, once, when the typed query finds nothing', async () => {
    useBrowse.setState({ sel: albumSel(`old-${run}`) })
    const page = deferred<BrowsePage>()
    ghost.api.catalog.browse.mockReturnValueOnce(page.promise)
    useBrowse.setState({ text: 'zzz' })
    const done = playResult(true)
    page.resolve({ total: 0, offset: 0, groups: [] })
    await done
    expect(playAlbum).not.toHaveBeenCalled()
    expect(useBrowse.getState().externalAuto).toBe('zzz')
  })

  it('does nothing once more is typed before the results arrive', async () => {
    const page = deferred<BrowsePage>()
    ghost.api.catalog.browse.mockReturnValueOnce(page.promise)
    useBrowse.setState({ text: 'be' })
    const done = playResult(true)
    useBrowse.setState({ text: 'beta' })
    void browseModel.setQuery({ text: 'beta', group: 'game', sort: 'title' })
    page.resolve({ total: 0, offset: 0, groups: [] })
    await done
    await flush()
    expect(playAlbum).not.toHaveBeenCalled()
    expect(useBrowse.getState().externalAuto).toBeNull()
  })

  it('plays the selection at once when its results are current', async () => {
    useBrowse.setState({ sel: albumSel(`cur-${run}`) })
    await playResult(false)
    expect(playAlbum.mock.calls).toEqual([[`cur-${run}`, 0]])
  })
})

describe('play requests', () => {
  it('an older, slower play never replaces a newer one', async () => {
    const slow = deferred<AlbumDetail>()
    const [a, b] = [`a-${run}`, `b-${run}`]
    ghost.api.catalog.album.mockImplementation(async (id) => (id === a ? slow.promise : detail(album(b), [`${b}-1`])))
    const pa = playSelection(albumSel(a))
    await playSelection(albumSel(b))
    slow.resolve(detail(album(a), [`${a}-1`]))
    await pa
    expect(playAlbum.mock.calls).toEqual([[b, 0]])
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('an older play failing after a newer one started says nothing', async () => {
    const slow = deferred<AlbumDetail>()
    const [a, b] = [`a-${run}`, `b-${run}`]
    ghost.api.catalog.album.mockImplementation(async (id) => (id === a ? slow.promise : detail(album(b), [`${b}-1`])))
    playAlbum.mockImplementation(async (id) => {
      if (id === a) throw new Error('gone')
    })
    const pa = playSelection(albumSel(a))
    await playSelection(albumSel(b))
    slow.resolve(detail(album(a), [`${a}-1`]))
    await pa
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
    playAlbum.mockImplementation(async () => {})
  })

  it('leaving Browse drops a play still fetching its album', async () => {
    const slow = deferred<AlbumDetail>()
    const a = `a-${run}`
    ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
    const pa = playSelection(albumSel(a))
    cancelPlay()
    slow.resolve(detail(album(a), [`${a}-1`]))
    await pa
    expect(playAlbum).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('previews', () => {
  it('an automatic preview on its way does not start once the queue plays', async () => {
    const slow = deferred<AlbumDetail>()
    const a = `p-${run}`
    ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
    const p = startPreview(albumSel(a), true)
    usePlayer.setState({ status: 'playing' })
    slow.resolve(detail(album(a), [`${a}-1`]))
    expect(await p).toBe(false)
    expect(ghost.api.player.preview).not.toHaveBeenCalled()
  })

  it('a preview on its way stops when the selection leaves its album, or a query empties it', async () => {
    for (const next of [albumSel(`other-${run}`), null]) {
      const slow = deferred<AlbumDetail>()
      const a = `q-${run}-${next ? 1 : 2}`
      ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
      const p = startPreview(albumSel(a), true)
      previewFollowSelection(next)
      slow.resolve(detail(album(a), [`${a}-1`]))
      expect(await p).toBe(false)
    }
    // ...and while it stays in the album, it carries on
    const slow = deferred<AlbumDetail>()
    const a = `q-${run}-3`
    ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
    const p = startPreview(albumSel(a), true)
    previewFollowSelection({ ...albumSel(a), id: 'another row of it' })
    slow.resolve(detail(album(a), [`${a}-1`]))
    expect(await p).toBe(true)
    expect(ghost.api.player.preview).toHaveBeenCalledTimes(1)
  })

  it('P again while its preview loads drops it; P’s own preview may pause the queue', async () => {
    usePlayer.setState({ status: 'playing' })
    const slow = deferred<AlbumDetail>()
    const a = `r-${run}`
    ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
    const first = togglePreview(albumSel(a))
    await togglePreview(albumSel(a))
    slow.resolve(detail(album(a), [`${a}-1`]))
    await first
    expect(ghost.api.player.preview).not.toHaveBeenCalled()

    await togglePreview(albumSel(a))
    expect(ghost.api.player.preview).toHaveBeenCalledWith(`${a}-1`)
  })
})

describe('stale track lists', () => {
  it('a cached track list made stale is fetched again once the selection rests on it, and play uses the new one', async () => {
    const id = `s-${run}`
    ghost.api.catalog.album.mockResolvedValueOnce(detail(album(id), ['t1', 't2', 't3']))
    await browseModel.loadDetail(id)
    // the catalog changed while another album was selected
    browseModel.refresh([], [], [])
    const old = browseModel.peekDetail(id)!
    const sel = selOf(group(`album:${id}`), { id: `0|album:${id}||t3`, kind: 'track', detail: old, album: old.album, track: old.tracks[2], trackIndex: 2 })
    expect(restingAlbum(sel)).toBe(id)

    ghost.api.catalog.album.mockResolvedValueOnce(detail(album(id), ['t3', 't1', 't2']))
    await playSelection(sel)
    expect(playAlbum.mock.calls).toEqual([[id, 0]])
    expect(restingAlbum(sel)).toBeNull()
  })
})
