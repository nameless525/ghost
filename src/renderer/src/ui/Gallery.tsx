// Living reference for the UI kit. Open http://localhost:5173/?kit to see every component.
import { Download, Heart, LibraryBig, ListMusic, ListPlus, Play, Plus, Repeat, Shuffle, SkipForward, Sparkles, Trash2, Trophy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { notify } from '../shell/notifications'
import {
  Button,
  ContextMenu,
  CoverArt,
  IconButton,
  IntensityBadge,
  Kbd,
  LoadingRing,
  Marquee,
  Panel,
  ProgressRing,
  ScrollArea,
  SearchInput,
  SegmentedControl,
  Select,
  ShearButton,
  Slider,
  SourceBadge,
  Toggle,
  Tooltip,
  Wedge,
  confirmDialog,
  formatTime,
  promptDialog,
  type ConfirmOptions
} from './index'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="g-gallery__section">
      <h3 className="g-gallery__title">{title}</h3>
      <div className="g-gallery__row">{children}</div>
    </section>
  )
}

/** Highlights `key=value` / `key>value` filter tokens, keeping every character in place. */
function demoHighlight(text: string): ReactNode {
  return text.split(/(\s+)/).map((tok, i) =>
    /^[a-z]+(=|!=|>=|<=|>|<)\S*$/i.test(tok) ? (
      <span key={i} style={{ color: 'var(--accent-hi)', background: 'rgb(var(--accent-rgb) / 0.16)', borderRadius: 4 }}>
        {tok}
      </span>
    ) : (
      <span key={i}>{tok}</span>
    )
  )
}

export default function Gallery() {
  const [vol, setVol] = useState(0.7)
  const [seek, setSeek] = useState(83000)
  const [on, setOn] = useState(true)
  const [off, setOff] = useState(false)
  const [group, setGroup] = useState<'game' | 'album' | 'composer' | 'year'>('game')
  const [tab, setTab] = useState('playlists')
  const [q, setQ] = useState('boss platform=snes intensity>5')
  const [loading, setLoading] = useState(false)
  const confirmOpts: ConfirmOptions = { title: 'Delete “Boss rush”?', body: 'The playlist and its order will be gone. Tracks stay in your library.', confirmLabel: 'Delete', danger: true }

  return (
    <ScrollArea className="g-gallery">
      <div className="g-gallery__inner">
        <h1 className="g-gallery__h1">GHOST UI kit</h1>
        <p className="g-muted">Every component, every state. Source: src/renderer/src/ui — docs: ui/README.md</p>

        <Section title="Button">
          <Button variant="primary" icon={<Play />}>
            Play all
          </Button>
          <Button variant="secondary" icon={<ListPlus />}>
            Queue
          </Button>
          <Button variant="soft" icon={<Sparkles />}>
            Soft
          </Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<Trash2 />}>
            Delete
          </Button>
          <Button variant="primary" hue="library" size="sm">
            Library hue
          </Button>
          <Button variant="primary" size="lg" loading={loading} onClick={() => (setLoading(true), setTimeout(() => setLoading(false), 1500))}>
            Click to load
          </Button>
          <Button disabled>Disabled</Button>
        </Section>

        <Section title="ShearButton (lazer footer)">
          <ShearButton icon={<Shuffle />} label="Random" hue="browse" />
          <ShearButton icon={<ListMusic />} label="Queue" hue="library" active />
          <ShearButton icon={<Download />} label="Download" hue="downloads" />
          <ShearButton icon={<Plus />} label="Add to playlist" hue="settings" size="sm" />
          <ShearButton icon={<Trophy />} label="Large" hint="With a hint line" size="lg" hue="radio" />
        </Section>

        <Section title="IconButton">
          <IconButton icon={<Heart />} label="Like" shortcut="Mod+K" />
          <IconButton icon={<Heart fill="currentColor" />} label="Liked" active />
          <IconButton icon={<Shuffle />} label="Shuffle" variant="subtle" />
          <IconButton icon={<Repeat />} label="Repeat" variant="subtle" active />
          <IconButton icon={<SkipForward />} label="Next" size="lg" />
          <IconButton icon={<Play fill="currentColor" />} label="Play" size="xl" variant="solid" />
          <IconButton icon={<Trash2 />} label="Disabled" disabled />
        </Section>

        <Section title="Panel · Wedge">
          <Panel style={{ width: 220 }}>Plain glass panel</Panel>
          <Panel interactive style={{ width: 220 }}>
            Interactive (hover me)
          </Panel>
          <Panel sheared interactive selected style={{ width: 260 }}>
            Sheared + selected
          </Panel>
          <div style={{ width: 300, overflow: 'hidden', paddingLeft: 0 }}>
            <Wedge glow style={{ width: 280 }}>
              <b>Wedge</b>
              <div className="g-muted">bleeds off the left edge</div>
            </Wedge>
          </div>
        </Section>

        <Section title="Slider">
          <div style={{ width: 260 }}>
            <Slider value={vol} onChange={setVol} variant="volume" format={(v) => `${Math.round(v * 100)}%`} aria-label="Volume" />
          </div>
          <div style={{ width: 360 }}>
            <Slider value={seek} min={0} max={172000} onChange={setSeek} variant="seek" format={formatTime} buffered={0.8} aria-label="Seek" />
          </div>
          <span className="tnum g-muted">
            {Math.round(vol * 100)}% · {formatTime(seek)}
          </span>
        </Section>

        <Section title="Toggle · Select · SegmentedControl">
          <Toggle checked={on} onChange={setOn} aria-label="On" />
          <Toggle checked={off} onChange={setOff} aria-label="Off" />
          <div style={{ width: 300 }}>
            <Toggle checked={on} onChange={setOn} label="Gapless playback" description="No silence between album tracks" />
          </div>
          <Select
            value={group}
            onChange={setGroup}
            prefix="group:"
            options={[
              { value: 'game', label: 'Game' },
              { value: 'album', label: 'Album' },
              { value: 'composer', label: 'Composer' },
              { value: 'year', label: 'Year', hint: '1985–2024' }
            ]}
          />
          <SegmentedControl
            value={tab}
            onChange={setTab}
            hue="library"
            options={[
              { value: 'playlists', label: 'Playlists' },
              { value: 'liked', label: 'Liked' },
              { value: 'history', label: 'History' },
              { value: 'downloaded', label: 'Downloaded' }
            ]}
          />
        </Section>

        <Section title="SearchInput (with highlighter)">
          <div style={{ width: 460 }}>
            <SearchInput value={q} onChange={setQ} highlight={demoHighlight} placeholder="Search games, albums, composers…" />
          </div>
        </Section>

        <Section title="Badges · Kbd · LoadingRing · ProgressRing">
          {[0.9, 1.6, 2.3, 3.1, 4.4, 5.3, 6.2, 7.4, 8.6].map((v) => (
            <IntensityBadge key={v} value={v} />
          ))}
          <IntensityBadge value={null} />
          <IntensityBadge value={6.2} size="lg" glow />
          <SourceBadge source={{ provider: 'khinsider', format: 'flac', lossless: true, bitrateKbps: 1011 }} />
          <SourceBadge source={{ provider: 'khinsider', format: 'mp3', lossless: false, bitrateKbps: 320 }} />
          <SourceBadge source={{ provider: 'khinsider', format: 'mp3', lossless: false, bitrateKbps: 128 }} />
          <SourceBadge source="chip" />
          <SourceBadge source={{ provider: 'youtube', format: 'opus', lossless: false, bitrateKbps: 160 }} />
          <Kbd combo="Mod+Shift+L" />
          <Kbd combo="F2" />
          <Kbd combo="Escape" />
          <LoadingRing />
          <LoadingRing box size={22} />
          <ProgressRing value={0.66} size={28} hue="downloads" />
          <ProgressRing value={null} size={28} />
        </Section>

        <Section title="CoverArt · Marquee · Tooltip">
          <CoverArt src={null} size={72} />
          <CoverArt src={null} size={72} hue="library" />
          <div style={{ width: 200, padding: 10 }} className="g-panel">
            <Marquee>Dancing Mad (Fourth Movement: Kefka’s Theme) — Final Fantasy VI</Marquee>
          </div>
          <Tooltip content="Tooltips flip to stay on screen" shortcut="Mod+L">
            <Button variant="secondary">Hover for a tooltip</Button>
          </Tooltip>
        </Section>

        <Section title="ContextMenu · Dialogs · Toasts">
          <ContextMenu
            items={() => [
              { heading: 'Peaceful Days' },
              { label: 'Play next', icon: <ListPlus />, shortcut: 'Shift+Q' },
              { label: 'Add to queue', icon: <ListMusic />, shortcut: 'Q' },
              { label: 'Add to playlist', icon: <LibraryBig />, submenu: [{ label: 'Boss rush' }, { label: 'Study / ambient' }, { separator: true }, { label: 'New playlist…', icon: <Plus /> }] },
              { separator: true },
              { label: 'Like', icon: <Heart />, checked: true },
              { label: 'Download', icon: <Download />, shortcut: 'Mod+D' },
              { separator: true },
              { label: 'Remove from playlist', icon: <Trash2 />, danger: true }
            ]}
          >
            <Panel interactive style={{ width: 220 }}>
              Right-click me
            </Panel>
          </ContextMenu>
          <Button variant="secondary" onClick={() => void confirmDialog(confirmOpts)}>
            Confirm…
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              const name = await promptDialog({ title: 'New playlist', label: 'Name', placeholder: 'Boss rush', validate: (v) => (v.trim() ? null : 'Give it a name') })
              if (name) notify({ kind: 'success', title: 'Playlist created', body: name })
            }}
          >
            Prompt…
          </Button>
          <Button variant="secondary" onClick={() => notify({ kind: 'info', title: 'Catalog updated', body: '1,204 new albums from KHInsider' })}>
            Info toast
          </Button>
          <Button variant="secondary" onClick={() => notify({ kind: 'error', title: 'Couldn’t reach KHInsider', body: 'Falling back to the Internet Archive' })}>
            Error toast
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              let p = 0
              const tick = () => {
                p = Math.min(1, p + 0.2)
                notify({ id: 'gallery-progress', kind: p < 1 ? 'progress' : 'success', title: p < 1 ? 'Downloading album' : 'Album downloaded', body: `${Math.round(p * 12)} of 12 tracks`, progress: p })
                if (p < 1) setTimeout(tick, 700)
              }
              tick()
            }}
          >
            Progress toast
          </Button>
        </Section>
      </div>
    </ScrollArea>
  )
}
