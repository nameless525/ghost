// "New playlist": manual (name + description) or smart (name + saved search query with live
// syntax highlighting and examples).
import { ListMusic, ListPlus, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseSearch } from '@shared/search'
import type { Playlist } from '@shared/types'
import { ghost } from '../../ghost'
import { tween } from '../../motion/tween'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { isMac } from '../../theme'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { cx } from '../../ui/util'
import { QueryField } from './query'

export type PlaylistKind = 'manual' | 'smart'

export interface NewPlaylistDialogProps {
  open: boolean
  kind: PlaylistKind
  onClose: () => void
  onCreated: (p: Playlist) => void
}

export function NewPlaylistDialog({ open, kind: initialKind, onClose, onCreated }: NewPlaylistDialogProps) {
  const [kind, setKind] = useState<PlaylistKind>(initialKind)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [query, setQuery] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // A ref, not just `busy`: Enter in the query field submitted twice in one render (the field's
  // onSubmit, then the same keydown bubbling to the form), creating two playlists.
  const submitting = useRef(false)

  useEffect(() => {
    if (!open) return
    submitting.current = false
    setKind(initialKind)
    setName('')
    setDescription('')
    setQuery('')
    setNameTouched(false)
    setTried(false)
    setBusy(false)
    const t = window.setTimeout(() => nameRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [open, initialKind])

  const parsed = useMemo(() => parseSearch(query), [query])
  const nameError = !name.trim() ? 'Give it a name' : null
  const queryError = kind === 'smart' ? (parsed.errors.length ? parsed.errors[0].message : parsed.empty ? 'Enter a search query' : null) : null
  const valid = !nameError && !queryError

  const shake = () => {
    sfx.play('error', { volume: 0.6 })
    if (body.current) void tween(body.current).moveToX(7, 50).then().moveToX(-6, 70).then().moveToX(0, 320, 'outElastic')
  }

  const submit = async () => {
    setTried(true)
    if (submitting.current) return
    if (!valid || busy) {
      shake()
      return
    }
    submitting.current = true
    setBusy(true)
    try {
      const p = await ghost().library.playlists.create(name.trim(), {
        description: description.trim() || undefined,
        query: kind === 'smart' ? query.trim() : undefined
      })
      sfx.play('confirm')
      notify({ kind: 'success', title: kind === 'smart' ? 'Smart playlist created' : 'Playlist created', body: p.name, ephemeral: true })
      onCreated(p)
    } catch (err) {
      notify({ kind: 'error', title: 'Could not create playlist', body: String((err as Error)?.message ?? err) })
      setBusy(false)
      submitting.current = false
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      hue="library"
      width={kind === 'smart' ? 600 : 460}
      title={kind === 'smart' ? 'New smart playlist' : 'New playlist'}
      icon={kind === 'smart' ? <Sparkles /> : <ListPlus />}
      footer={
        <>
          <Button variant="ghost" sound="back" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" sound={false} loading={busy} onClick={() => void submit()} hue="library">
            Create
          </Button>
        </>
      }
    >
      <div
        ref={body}
        className="lx-newpl"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <SegmentedControl
          block
          hue="library"
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: 'manual', label: 'Manual', icon: <ListMusic size={15} /> },
            { value: 'smart', label: 'Smart', icon: <Sparkles size={15} /> }
          ]}
          aria-label="Playlist type"
        />
        <p className="lx-newpl__hint">
          {kind === 'smart'
            ? 'A saved search. It fills itself with every track that matches and stays up to date as your library grows.'
            : `Hand-picked tracks in your own order. Add tracks from Browse with right-click or ${isMac ? '⌘S' : 'Ctrl+S'}.`}
        </p>
        <label className="g-field">
          <span className="g-field__label">Name</span>
          <input
            ref={nameRef}
            className={cx('g-input', (tried || nameTouched) && nameError && 'g-input--invalid')}
            value={name}
            maxLength={120}
            placeholder={kind === 'smart' ? 'SNES bangers' : 'Boss rush'}
            onChange={(e) => {
              setName(e.target.value)
              setNameTouched(true)
            }}
          />
          {tried && nameError && <span className="g-field__error">{nameError}</span>}
        </label>
        <div className={cx('lx-reveal', kind === 'smart' && 'lx-reveal--open')}>
          <div className="lx-reveal__inner">
            <div className="g-field">
              <span className="g-field__label">Query</span>
              <QueryField
                value={query}
                onChange={setQuery}
                onSubmit={() => void submit()}
                onExample={(ex) => {
                  if (!name.trim() || !nameTouched) setName(ex.label)
                }}
              />
              {tried && queryError && <span className="g-field__error">{queryError}</span>}
            </div>
          </div>
        </div>
        <label className="g-field">
          <span className="g-field__label">
            Description <span className="lx-optional">optional</span>
          </span>
          <input className="g-input" value={description} maxLength={300} placeholder="What's it for?" onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
    </Dialog>
  )
}
