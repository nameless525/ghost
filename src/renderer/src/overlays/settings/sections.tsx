// Every setting, declared once: section → group → row. Labels, descriptions and keywords drive
// the search filter; each row's component renders the live control.
import {
  AudioLines,
  Check,
  Database,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Image as ImageGlyph,
  Info,
  KeyRound,
  LockKeyhole,
  Monitor,
  Plug,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Waypoints,
  X
} from 'lucide-react'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { defaultSettings } from '@shared/defaults'
import type { AudioDevice, CatalogStatus, DeepPartial, Settings } from '@shared/types'
import { ghost } from '../../ghost'
import { animateValue } from '../../motion/tween'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { useSettings } from '../../state/settings'
import { Button } from '../../ui/Button'
import { GhostMark } from '../../ui/GhostMark'
import { IconButton } from '../../ui/IconButton'
import { Kbd } from '../../ui/Kbd'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Select, type SelectOption } from '../../ui/Select'
import { Toggle } from '../../ui/Toggle'
import { cx } from '../../ui/util'
import { leavingStyle, relativeTime, useAnimatedList, useNow } from '../library/common'
import { Highlight, patchSettings, Row, SearchContext, SecretField, SettingSlider } from './controls'
import { ActivityNote, SourceActivityList } from '../../screens/browse/CatalogActivity'
import { ProviderList } from './ProviderList'

export type SectionId = 'audio' | 'sources' | 'library' | 'interface' | 'integrations' | 'catalog' | 'about'

export interface RowMeta {
  label: string
  description?: string
}

export interface RowDef extends RowMeta {
  id: string
  /** Extra search terms. */
  keywords?: string
  C: ComponentType<RowMeta>
}

export interface GroupDef {
  title: string
  rows: RowDef[]
}

export interface SectionDef {
  id: SectionId
  title: string
  icon: ReactNode
  blurb: string
  groups: GroupDef[]
}

/** True while the overlay is open (rows refresh device lists, catalog status…). */
export const OpenContext = createContext(false)

// ---------------------------------------------------------------------------
// Row factories

type Get<T> = (s: Settings) => T
type Put<T> = (v: T) => DeepPartial<Settings>

function toggleRow(get: Get<boolean>, set: Put<boolean>, opts: { disabled?: Get<boolean>; after?: (v: boolean) => void; description?: () => ReactNode } = {}): ComponentType<RowMeta> {
  return function ToggleRow(m: RowMeta) {
    const v = useSettings(get)
    const disabled = useSettings((s) => opts.disabled?.(s) ?? false)
    const desc = opts.description?.() ?? null
    const change = (x: boolean) => {
      void patchSettings(set(x))
      opts.after?.(x)
    }
    return (
      <div
        className="set-row-click"
        onClick={(e) => {
          if (disabled || (e.target as HTMLElement).closest('button, a, input')) return
          sfx.play(v ? 'toggleOff' : 'toggleOn')
          change(!v)
        }}
      >
        <Row {...m} description={desc ?? m.description} disabled={disabled}>
          <Toggle checked={v} disabled={disabled} onChange={change} aria-label={m.label} />
        </Row>
      </div>
    )
  }
}

function sliderRow(
  get: Get<number>,
  set: Put<number>,
  o: { min: number; max: number; step: number; format: (v: number) => string; disabled?: Get<boolean>; after?: (v: number) => void }
): ComponentType<RowMeta> {
  return function SliderRow(m: RowMeta) {
    const v = useSettings(get)
    const disabled = useSettings((s) => o.disabled?.(s) ?? false)
    return (
      <Row {...m} disabled={disabled} stack>
        <SettingSlider
          value={v}
          min={o.min}
          max={o.max}
          step={o.step}
          format={o.format}
          disabled={disabled}
          aria-label={m.label}
          onCommit={(x) => {
            void patchSettings(set(x))
            o.after?.(x)
          }}
        />
      </Row>
    )
  }
}

function segRow<T extends string>(get: Get<T>, set: Put<T>, options: { value: T; label: string; icon?: ReactNode; description?: string }[], opts: { disabled?: Get<boolean> } = {}): ComponentType<RowMeta> {
  return function SegRow(m: RowMeta) {
    const v = useSettings(get)
    const disabled = useSettings((s) => opts.disabled?.(s) ?? false)
    const desc = options.find((o) => o.value === v)?.description
    return (
      <Row {...m} description={desc ?? m.description} disabled={disabled} stack>
        <SegmentedControl block value={v} onChange={(x) => void patchSettings(set(x))} options={options.map((o) => ({ value: o.value, label: o.label, icon: o.icon, disabled }))} aria-label={m.label} />
      </Row>
    )
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`

// ---------------------------------------------------------------------------
// Audio

function DeviceRow(m: RowMeta) {
  const device = useSettings((s) => s.audio.device)
  const open = useContext(OpenContext)
  const [devices, setDevices] = useState<AudioDevice[] | null>(null)
  useEffect(() => {
    if (!open) return
    ghost()
      .player.devices()
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [open])
  const sysDefault = devices?.find((d) => d.isDefault && d.id !== 'default')
  const options: SelectOption<string>[] = [
    { value: 'default', label: 'System default', hint: sysDefault ? sysDefault.name : 'follows your OS', text: 'System default' },
    ...(devices ?? []).filter((d) => d.id !== 'default').map((d) => ({ value: d.id, label: d.name, hint: d.isDefault ? 'current' : undefined, text: d.name }))
  ]
  if (device !== 'default' && devices && !options.some((o) => o.value === device)) options.push({ value: device, label: 'Unavailable device', hint: 'disconnected', text: device })
  return (
    <Row {...m} stack>
      <Select value={device} options={options} onChange={(v) => void patchSettings({ audio: { device: v } })} width="100%" aria-label="Output device" />
    </Row>
  )
}

const LOOP_DESC: Record<Settings['audio']['loopMode'], string> = {
  album: 'Like the album version: plays the loop twice, then fades out.',
  endless: 'Loops forever, the way the game does, until you skip.',
  custom: 'Use your own loop count and fade length below.'
}

const notCustom = (s: Settings) => s.audio.loopMode !== 'custom'

// ---------------------------------------------------------------------------
// Sources

function FoldersRow(m: RowMeta) {
  const folders = useSettings((s) => s.sources.localFolders)
  const list = useRef<HTMLUListElement>(null)
  const entries = useMemo(() => folders.map((f) => ({ key: f, data: f })), [folders])
  const rows = useAnimatedList(list, entries, { exitMs: 260 })
  const add = async () => {
    const p = await ghost().settings.pickFolder()
    if (!p) return
    if (folders.includes(p)) {
      notify({ kind: 'info', title: 'Already added', body: p })
      return
    }
    sfx.play('confirm', { volume: 0.6 })
    void patchSettings({ sources: { localFolders: [...folders, p] } })
  }
  return (
    <Row {...m} wide>
      <ul ref={list} className="set-folders">
        {rows.map(({ key, data: f, leaving, box }) => (
          <li key={key} className="set-folder" data-flip={key} data-leaving={leaving || undefined} style={leaving ? leavingStyle(box) : undefined}>
            <FolderOpen className="set-folder__icon" />
            <span className="set-path lx-mono" title={f}>
              <span>{f}</span>
            </span>
            <IconButton size="sm" icon={<FolderSearch />} label="Show folder" onClick={() => void ghost().system.reveal(f)} />
            <IconButton
              size="sm"
              icon={<X />}
              label="Remove folder"
              sound="back"
              onClick={() => void patchSettings({ sources: { localFolders: folders.filter((x) => x !== f) } })}
            />
          </li>
        ))}
      </ul>
      {!folders.length && <div className="set-hint">No folders yet. Add the folders where you keep soundtrack rips and GHOST matches them to the catalog.</div>}
      <div className="set-actions">
        <Button size="sm" variant="soft" icon={<FolderPlus />} onClick={() => void add()}>
          Add folder
        </Button>
      </div>
    </Row>
  )
}

// ---------------------------------------------------------------------------
// Library

function DownloadDirRow(m: RowMeta) {
  const dir = useSettings((s) => s.library.downloadDir)
  const change = async () => {
    const p = await ghost().settings.pickFolder()
    if (!p || p === dir) return
    sfx.play('confirm', { volume: 0.6 })
    void patchSettings({ library: { downloadDir: p } })
  }
  return (
    <Row {...m} wide>
      <div className="set-dir">
        <FolderOpen className="set-folder__icon" />
        <span className="set-path lx-mono" title={dir}>
          <span>{dir || 'Not set'}</span>
        </span>
        <Button size="sm" variant="ghost" icon={<FolderSearch />} onClick={() => void ghost().downloads.openFolder()}>
          Open
        </Button>
        <Button size="sm" variant="soft" onClick={() => void change()}>
          Change…
        </Button>
      </div>
    </Row>
  )
}

export const TEMPLATE_TOKENS: { token: string; label: string }[] = [
  { token: 'game', label: 'Game' },
  { token: 'album', label: 'Album' },
  { token: 'year', label: 'Year' },
  { token: 'disc', label: 'Disc' },
  { token: 'track', label: 'Track #' },
  { token: 'title', label: 'Title' },
  { token: 'composer', label: 'Composer' },
  { token: 'platform', label: 'Platform' },
  { token: 'kind', label: 'Kind' },
  { token: 'catalog', label: 'Catalog no.' }
]
const SAMPLE: Record<string, string> = {
  game: 'Chrono Trigger',
  album: 'Chrono Trigger Original Sound Version',
  year: '1995',
  disc: '2',
  track: '06',
  title: 'Battle with Magus',
  composer: 'Yasunori Mitsuda',
  platform: 'SNES',
  kind: 'ost',
  catalog: 'PSCN-5021'
}

/** Template → segments of [text, isToken, known] parts, for the live example. */
function renderTemplate(tpl: string): { parts: { text: string; token: boolean; known: boolean }[] }[] {
  const segs = (tpl || '{title}').replace(/\\/g, '/').split('/').filter((s) => s.trim() !== '')
  return segs.map((seg) => {
    const parts: { text: string; token: boolean; known: boolean }[] = []
    let last = 0
    for (const m of seg.matchAll(/\{(\w+)\}/g)) {
      if (m.index! > last) parts.push({ text: seg.slice(last, m.index), token: false, known: true })
      const k = m[1].toLowerCase()
      const known = k in SAMPLE
      parts.push({ text: known ? SAMPLE[k].replace(/[/\\]/g, '-') : m[0], token: true, known })
      last = m.index! + m[0].length
    }
    if (last < seg.length) parts.push({ text: seg.slice(last), token: false, known: true })
    return { parts }
  })
}

function NamingRow(m: RowMeta) {
  const saved = useSettings((s) => s.library.namingTemplate)
  const dir = useSettings((s) => s.library.downloadDir)
  const [draft, setDraft] = useState(saved)
  const input = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  const timer = useRef(0)
  const def = useMemo(() => defaultSettings('').library.namingTemplate, [])

  useEffect(() => {
    if (!focused.current) setDraft(saved)
  }, [saved])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = (v: string) => {
    window.clearTimeout(timer.current)
    const clean = v.trim() || def
    if (clean !== v) setDraft(clean)
    if (clean !== saved) void patchSettings({ library: { namingTemplate: clean } })
  }
  const update = (v: string) => {
    setDraft(v)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => v.trim() && commit(v), 700)
  }
  const insert = (token: string) => {
    const el = input.current
    const t = `{${token}}`
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + t + draft.slice(end)
    sfx.play('select', { volume: 0.5 })
    update(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + t.length, start + t.length)
    })
  }

  const segs = renderTemplate(draft)
  const unknown = [...draft.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).filter((k) => !(k.toLowerCase() in SAMPLE))
  const weak = !/\{(title|track)\}/i.test(draft)

  return (
    <Row {...m} wide>
      <div className="set-tpl">
        <div className="set-tpl__field">
          <input
            ref={input}
            className="g-input lx-mono set-tpl__input"
            value={draft}
            spellCheck={false}
            aria-label="Naming template"
            onFocus={() => (focused.current = true)}
            onBlur={() => {
              focused.current = false
              commit(draft)
            }}
            onChange={(e) => update(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(draft)
              else if (e.key === 'Escape' && draft !== saved) {
                e.preventDefault()
                e.stopPropagation()
                setDraft(saved)
              }
            }}
          />
          {draft !== def && (
            <IconButton
              size="sm"
              icon={<RotateCcw />}
              label="Reset to default"
              onClick={() => {
                setDraft(def)
                commit(def)
              }}
            />
          )}
        </div>
        <div className="set-tpl__tokens">
          {TEMPLATE_TOKENS.map((t) => (
            <button key={t.token} type="button" className="set-chip" title={`Insert {${t.token}}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t.token)} onPointerEnter={() => sfx.play('hover')}>
              <code>{`{${t.token}}`}</code>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="set-tpl__example">
          <span className="set-tpl__example-label">Example</span>
          <div className="set-tpl__path lx-mono">
            <span className="set-tpl__base">{dir.replace(/[\\/]+$/, '')}</span>
            {segs.map((s, i) => (
              <span key={i} className="set-tpl__seg">
                <span className="set-tpl__slash">/</span>
                {s.parts.map((p, j) => (
                  <span key={j} className={cx(p.token && 'set-tpl__tok', !p.known && 'set-tpl__tok--bad')}>
                    {p.text}
                  </span>
                ))}
                {i === segs.length - 1 && <span className="set-tpl__ext">.flac</span>}
              </span>
            ))}
          </div>
          {(unknown.length > 0 || weak) && (
            <div className="set-tpl__warn">
              <TriangleAlert />
              {unknown.length > 0 ? `Unknown ${unknown.length === 1 ? 'token' : 'tokens'} ${unknown.map((u) => `{${u}}`).join(', ')} will be left empty.` : 'Without {title} or {track}, files from one album would share a name.'}
            </div>
          )}
        </div>
      </div>
    </Row>
  )
}

// ---------------------------------------------------------------------------
// Integrations

function useCatalogStatus(): CatalogStatus | null {
  const open = useContext(OpenContext)
  const [st, setSt] = useState<CatalogStatus | null>(null)
  useEffect(() => {
    if (!open) return
    void ghost()
      .catalog.status()
      .then(setSt)
      .catch(() => {})
    return ghost().on('catalog:status', setSt)
  }, [open])
  return st
}

function KeysNote() {
  return (
    <div className="set-note">
      <LockKeyhole />
      <div>
        <b>Keys stay on this machine.</b> They're saved in GHOST's local settings file and only ever sent to the service they belong to. Both are optional: without them, GHOST
        still plays everything, with less artwork and metadata.
      </div>
    </div>
  )
}

function StatusChip({ configured, active }: { configured: boolean; active: boolean | undefined }) {
  if (!configured) return <span className="set-status">Not set up</span>
  if (active) {
    return (
      <span className="set-status set-status--on">
        <Check /> Connected
      </span>
    )
  }
  return <span className="set-status set-status--wait">Saved</span>
}

function IntegrationCard({
  logo,
  name,
  what,
  link,
  linkLabel,
  steps,
  configured,
  active,
  children
}: {
  logo: ReactNode
  name: string
  what: string
  link: string
  linkLabel: string
  steps: string
  configured: boolean
  active: boolean | undefined
  children: ReactNode
}) {
  return (
    <div className={cx('set-int', configured && active && 'set-int--on')}>
      <div className="set-int__head">
        <span className="set-int__logo">{logo}</span>
        <div className="set-int__text">
          <div className="set-int__name">
            <Highlight text={name} />
            <StatusChip configured={configured} active={active} />
          </div>
          <div className="set-int__what">
            <Highlight text={what} />
          </div>
        </div>
      </div>
      <div className="set-int__fields">{children}</div>
      <div className="set-int__foot">
        <span className="set-int__steps">{steps}</span>
        <button type="button" className="set-link" onClick={() => void ghost().system.openExternal(link)} onPointerEnter={() => sfx.play('hover')}>
          {linkLabel}
          <ExternalLink />
        </button>
      </div>
    </div>
  )
}

function IgdbRow() {
  const id = useSettings((s) => s.keys.igdbClientId)
  const secret = useSettings((s) => s.keys.igdbClientSecret)
  const st = useCatalogStatus()
  return (
    <IntegrationCard
      logo={<KeyRound />}
      name="IGDB"
      what="Game metadata and cover art: release years, platforms, franchises and alternate titles for every game in the catalog."
      link="https://dev.twitch.tv/console"
      linkLabel="dev.twitch.tv/console"
      steps="Register an application on the Twitch developer console, then copy its client ID and generate a secret."
      configured={!!(id && secret)}
      active={st?.enrichment.igdb}
    >
      <label className="set-field">
        <span className="set-field__label">Client ID</span>
        <SecretField value={id} placeholder="e.g. jfu7…" aria-label="IGDB client ID" onSave={(v) => patchSettings({ keys: { igdbClientId: v } })} />
      </label>
      <label className="set-field">
        <span className="set-field__label">Client secret</span>
        <SecretField value={secret} placeholder="Paste your client secret" aria-label="IGDB client secret" onSave={(v) => patchSettings({ keys: { igdbClientSecret: v } })} />
      </label>
    </IntegrationCard>
  )
}

function SteamGridRow() {
  const key = useSettings((s) => s.keys.steamGridDbKey)
  const st = useCatalogStatus()
  return (
    <IntegrationCard
      logo={<ImageGlyph />}
      name="SteamGridDB"
      what="Hero images, logos and alternate covers: the big blurred backgrounds in Browse, the title screen and Now Playing."
      link="https://www.steamgriddb.com/profile/preferences/api"
      linkLabel="steamgriddb.com/profile/preferences/api"
      steps="Sign in (it's free), open Preferences → API and generate a key."
      configured={!!key}
      active={st?.enrichment.steamGridDb}
    >
      <label className="set-field">
        <span className="set-field__label">API key</span>
        <SecretField value={key} placeholder="Paste your API key" aria-label="SteamGridDB API key" onSave={(v) => patchSettings({ keys: { steamGridDbKey: v } })} />
      </label>
    </IntegrationCard>
  )
}

// ---------------------------------------------------------------------------
// Catalog

function CountUp({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null)
  const from = useRef(0)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const start = from.current
    from.current = value
    if (start === value) {
      node.textContent = value.toLocaleString()
      return
    }
    const a = animateValue({ from: start, to: value, duration: 900, easing: 'outQuint', onUpdate: (v) => (node.textContent = Math.round(v).toLocaleString()) })
    return () => a.cancel()
  }, [value])
  return (
    <span ref={el} className="tnum">
      0
    </span>
  )
}

function CatalogPanel() {
  const st = useCatalogStatus()
  const open = useContext(OpenContext)
  const now = useNow(30000, open)
  const [busy, setBusy] = useState(false)
  const indexing = !!st?.indexing
  const reindex = async () => {
    setBusy(true)
    sfx.play('confirm', { volume: 0.7 })
    try {
      await ghost().catalog.reindex()
      notify({ kind: 'info', title: 'Re-indexing the catalog', body: 'This runs in the background. Browse stays usable.' })
    } catch (err) {
      notify({ kind: 'error', title: 'Could not start indexing', body: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="set-cat">
      <div className="set-cat__tiles">
        {(
          [
            ['Games', st?.games],
            ['Albums', st?.albums],
            ['Tracks', st?.tracks]
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="set-cat__tile">
            <div className="set-cat__num">{n == null ? '–' : <CountUp value={n} />}</div>
            <div className="set-cat__label">{label}</div>
          </div>
        ))}
      </div>
      {st?.sources && st.sources.length > 0 && (
        <div className="set-cat__sources">
          <SourceActivityList sources={st.sources.filter((x) => x.state !== 'off')} />
          {indexing && <ActivityNote status={st} />}
        </div>
      )}
      <div className={cx('set-cat__progress', indexing && 'set-cat__progress--on')}>
        <div className="set-cat__progress-inner">
          <div className="set-cat__progress-row">
            <span className="set-cat__msg">{st?.message || 'Indexing provider catalogs…'}</span>
            {st?.progress != null && <b className="tnum">{Math.floor(st.progress * 100)}%</b>}
          </div>
          <div className="set-cat__bar">
            <div className="set-cat__fill" style={{ transform: `scaleX(${st?.progress ?? 0})` }} />
            {st?.progress == null && <div className="set-cat__indet g-keep-motion" />}
          </div>
        </div>
      </div>
      <div className="set-cat__foot">
        <div className="set-cat__meta">
          <span>
            Last indexed <b>{st?.lastIndexedAt ? relativeTime(st.lastIndexedAt, now) : 'never'}</b>
          </span>
          <span className="set-cat__enrich">
            <span className={cx('set-dotchip', st?.enrichment.igdb && 'set-dotchip--on')}>IGDB</span>
            <span className={cx('set-dotchip', st?.enrichment.steamGridDb && 'set-dotchip--on')}>SteamGridDB</span>
          </span>
        </div>
        <Button variant="soft" icon={<RefreshCw className={cx(indexing && 'set-spin g-keep-motion')} />} disabled={indexing || busy || !st} onClick={() => void reindex()}>
          {indexing ? 'Indexing…' : 'Re-index now'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// About

const SHORTCUTS: { keys: string[]; label: string; text?: string }[] = [
  { keys: ['ArrowUp', 'ArrowDown'], label: 'Move through the carousel' },
  { keys: ['ArrowLeft', 'ArrowRight'], label: 'Collapse / expand levels' },
  { keys: ['Enter'], label: 'Open the Play screen / expand' },
  { keys: ['Escape'], label: 'Back' },
  { keys: [], text: 'Just type', label: 'Search, anywhere in Browse' },
  { keys: ['Space'], label: 'Play / pause' },
  { keys: ['Mod+ArrowLeft', 'Mod+ArrowRight'], label: 'Previous / next track' },
  { keys: ['F2', 'Shift+F2'], label: 'Random / rewind random' },
  { keys: ['P'], label: 'Preview selection' },
  { keys: ['Q', 'Shift+Q'], label: 'Add to queue / play next' },
  { keys: ['Mod+S'], label: 'Add to playlist' },
  { keys: ['Mod+D'], label: 'Download' },
  { keys: ['Mod+L'], label: 'Library' },
  { keys: ['Mod+O'], label: 'Settings' },
  { keys: ['F6'], label: 'Music controller' },
  { keys: ['Alt+J'], label: 'Original / romanized titles' },
  { keys: ['1', 'Alt+1', '0'], label: 'Chiptunes on Play: mute / solo a channel (1–9), all on' },
  { keys: ['Mod+Shift+F'], label: 'FPS meter' }
]

function AboutPanel() {
  const open = useContext(OpenContext)
  const [info, setInfo] = useState<{ platform: string; version: string; dataDir: string; mock: boolean } | null>(null)
  const q = useContext(SearchContext)
  useEffect(() => {
    if (open && !info)
      void ghost()
        .system.info()
        .then(setInfo)
        .catch(() => {})
  }, [open, info])
  const shortcuts = q ? SHORTCUTS.filter((s) => `${s.label} ${s.keys.join(' ')} ${s.text ?? ''}`.toLowerCase().includes(q)) : SHORTCUTS
  const platformName = info ? ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux', web: 'Browser preview' } as Record<string, string>)[info.platform] ?? info.platform : ''
  return (
    <div className="set-about">
      {!q && (
        <div className="set-about__brand">
          <div className="set-about__mark">
            <GhostMark size={58} />
          </div>
          <div>
            <div className="set-about__word">GHOST</div>
            <div className="set-about__sub">Game Haven OST</div>
          </div>
          <div className="set-about__ver">
            <span className="set-about__chip tnum">v{info?.version ?? '…'}</span>
            {platformName && <span className="set-about__plat">{platformName}</span>}
          </div>
        </div>
      )}
      {!q && (
        <div className="set-dir set-dir--about">
          <span className="set-about__k">Data folder</span>
          <span className="set-path lx-mono" title={info?.dataDir}>
            <span>{info?.dataDir ?? '…'}</span>
          </span>
          <IconButton size="sm" icon={<FolderSearch />} label="Show data folder" disabled={!info || info.mock} onClick={() => info && void ghost().system.reveal(info.dataDir)} />
        </div>
      )}
      {shortcuts.length > 0 && (
        <div className="set-keys">
          <div className="set-group__title">Keyboard shortcuts</div>
          <dl className="set-keys__list">
            {shortcuts.map((s) => (
              <div key={s.label} className="set-keys__row">
                <dt>
                  <Highlight text={s.label} />
                </dt>
                <dd>
                  {s.text && <span className="set-keys__text">{s.text}</span>}
                  {s.keys.map((k, i) => (
                    <span key={k} className="set-keys__combo">
                      {i > 0 && <span className="set-keys__or">/</span>}
                      <Kbd combo={k} size="sm" />
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!q && <div className="set-about__credits">Audio by GHOST engine (Rust). Made for listening, not for sharing: everything stays on this computer.</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The registry

const row = (id: string, label: string, C: ComponentType<RowMeta>, description?: string, keywords?: string): RowDef => ({ id, label, C, description, keywords })

export const SECTIONS: SectionDef[] = [
  {
    id: 'audio',
    title: 'Audio',
    icon: <AudioLines />,
    blurb: 'Output, loudness, gapless and crossfade, chiptune loops, interface sounds.',
    groups: [
      { title: 'Output', rows: [row('device', 'Output device', DeviceRow, 'Follows the system default (e.g. when headphones connect) without stopping playback.', 'speaker headphones airpods dac sound card')] },
      {
        title: 'Loudness',
        rows: [
          row(
            'norm',
            'Loudness normalization',
            toggleRow(
              (s) => s.audio.normalization.enabled,
              (v) => ({ audio: { normalization: { enabled: v } } })
            ),
            'Evens out volume between tracks (EBU R128) with a true-peak safety limiter.',
            'volume replaygain r128 lufs level'
          ),
          row(
            'lufs',
            'Target loudness',
            sliderRow(
              (s) => s.audio.normalization.targetLufs,
              (v) => ({ audio: { normalization: { targetLufs: v } } }),
              { min: -23, max: -9, step: 1, format: (v) => `${v < 0 ? '−' : ''}${Math.abs(v)} LUFS`, disabled: (s) => !s.audio.normalization.enabled }
            ),
            'Lower is quieter with more headroom. −14 matches streaming services, −23 is broadcast.',
            'lufs normalization level volume'
          ),
          row(
            'normmode',
            'Gain mode',
            segRow(
              (s) => s.audio.normalization.mode,
              (v) => ({ audio: { normalization: { mode: v } } }),
              [
                { value: 'auto', label: 'Auto', description: 'Album gain when playing an album in order, track gain otherwise.' },
                { value: 'track', label: 'Track', description: 'Every track at the same loudness.' },
                { value: 'album', label: 'Album', description: 'Keeps the quiet and loud moments of an album as mastered.' }
              ],
              { disabled: (s) => !s.audio.normalization.enabled }
            ),
            'Track or album gain.',
            'replaygain album track normalization'
          )
        ]
      },
      {
        title: 'Playback',
        rows: [
          row(
            'gapless',
            'Gapless playback',
            toggleRow(
              (s) => s.audio.gapless,
              (v) => ({ audio: { gapless: v } })
            ),
            'Sample-accurate transitions, with encoder delay and padding trimmed.',
            'gap silence seamless'
          ),
          row(
            'xfade',
            'Crossfade',
            sliderRow(
              (s) => s.audio.crossfadeSec,
              (v) => ({ audio: { crossfadeSec: v } }),
              { min: 0, max: 12, step: 0.5, format: (v) => (v === 0 ? 'Off' : `${v} s`) }
            ),
            'Equal-power fade between tracks. Turns itself off between tracks of the same album.',
            'fade transition blend mix'
          )
        ]
      },
      {
        title: 'Chiptunes & loops',
        rows: [
          row(
            'loopmode',
            'Loop mode',
            segRow(
              (s) => s.audio.loopMode,
              (v) => ({ audio: { loopMode: v } }),
              [
                { value: 'album', label: 'Album', description: LOOP_DESC.album },
                { value: 'endless', label: 'Endless', description: LOOP_DESC.endless },
                { value: 'custom', label: 'Custom', description: LOOP_DESC.custom }
              ]
            ),
            'How looping formats (NSF, SPC, VGM, BRSTM…) end: 2 loops + fade, endless, or custom.',
            'chiptune loop nsf spc vgm fade endless repeat'
          ),
          row(
            'loopcount',
            'Loop count',
            sliderRow(
              (s) => s.audio.loopCount,
              (v) => ({ audio: { loopCount: v } }),
              { min: 1, max: 8, step: 1, format: (v) => `${v}×`, disabled: notCustom }
            ),
            'Times the looping section plays before the fade (Custom mode).',
            'chiptune repeat loops'
          ),
          row(
            'fadesec',
            'Fade-out',
            sliderRow(
              (s) => s.audio.fadeSec,
              (v) => ({ audio: { fadeSec: v } }),
              { min: 0, max: 30, step: 1, format: (v) => (v === 0 ? 'Cut' : `${v} s`), disabled: notCustom }
            ),
            'Length of the fade after the last loop (Custom mode).',
            'chiptune fade seconds'
          )
        ]
      },
      {
        title: 'Browse',
        rows: [
          row(
            'preview',
            'Preview on select',
            toggleRow(
              (s) => s.audio.previewOnSelect,
              (v) => ({ audio: { previewOnSelect: v } })
            ),
            'Resting on a game in Browse plays its signature track from its preview point.',
            'preview browse sample autoplay'
          )
        ]
      },
      {
        title: 'Interface sounds',
        rows: [
          row(
            'uisounds',
            'UI sounds',
            toggleRow(
              (s) => s.audio.uiSounds,
              (v) => ({ audio: { uiSounds: v } }),
              { after: (v) => v && window.setTimeout(() => sfx.play('confirm'), 60) }
            ),
            'Soft synthesized cues for hover, select and back, tuned so they never clash.',
            'sfx clicks effects feedback'
          ),
          row(
            'uivol',
            'UI sound volume',
            sliderRow(
              (s) => s.audio.uiSoundVolume,
              (v) => ({ audio: { uiSoundVolume: v } }),
              { min: 0, max: 1, step: 0.05, format: pct, disabled: (s) => !s.audio.uiSounds, after: () => window.setTimeout(() => sfx.play('confirm'), 30) }
            ),
            'Played on a separate bus that is never normalized.',
            'sfx loudness'
          )
        ]
      }
    ]
  },
  {
    id: 'sources',
    title: 'Sources',
    icon: <Waypoints />,
    blurb: 'Where music comes from, in what order, and at what quality.',
    groups: [
      {
        title: 'Providers',
        rows: [
          {
            id: 'providers',
            label: 'Source priority',
            description: 'GHOST tries sources from top to bottom and falls back automatically when one fails. Drag to reorder.',
            keywords: 'provider order local chiptune chip bandcamp khinsider zophar modland internet archive soundcloud youtube yt-dlp enable disable',
            C: (m) => (
              <Row {...m} wide>
                <ProviderList />
              </Row>
            )
          }
        ]
      },
      {
        title: 'Quality',
        rows: [
          row(
            'quality',
            'Streaming quality',
            segRow(
              (s) => s.sources.quality,
              (v) => ({ sources: { quality: v } }),
              [
                { value: 'lossless', label: 'Lossless', description: 'Prefer FLAC and original chip files whenever a source has them.' },
                { value: 'high', label: 'High', description: 'Prefer high-bitrate lossy (320 kbps / Opus) for faster starts.' },
                { value: 'saver', label: 'Data saver', description: 'Smallest streams that still sound good. Good for metered connections.' }
              ]
            ),
            'Lossless, high or data saver.',
            'bitrate flac mp3 bandwidth data saver'
          )
        ]
      },
      { title: 'Local music', rows: [row('folders', 'Local music folders', FoldersRow, 'Folders scanned by the Local files source.', 'local files folder directory rips scan')] },
      {
        title: 'Chiptune rips',
        rows: [
          row(
            'joshw',
            'Index joshw.info rip sets',
            toggleRow(
              (s) => s.sources.crawlJoshw,
              (v) => ({ sources: { crawlJoshw: v } })
            ),
            'Adds original-hardware NSF / SPC / GBS / HES / KSS sets for thousands of games. Off by default because joshw.info’s robots.txt asks automated tools not to crawl it; turn it on only if you’re comfortable with a slow, cached monthly read of its listings. vgmrips.net is always indexed.',
            'chip chiptune nsf spc gbs hes kss joshw hcs64 rips robots crawl'
          )
        ]
      }
    ]
  },
  {
    id: 'library',
    title: 'Library',
    icon: <FolderOpen />,
    blurb: 'Where downloads go, how they are named, and how much to cache.',
    groups: [
      {
        title: 'Downloads',
        rows: [
          row('dldir', 'Download folder', DownloadDirRow, 'Downloads are saved as-is (never re-encoded) and fully tagged.', 'path directory save location'),
          row('naming', 'File naming', NamingRow, 'Use / for folders. Click a token to insert it.', 'template naming pattern filename tokens rename')
        ]
      },
      {
        title: 'Cache',
        rows: [
          row(
            'cache',
            'Stream cache size',
            sliderRow(
              (s) => s.library.cacheMaxGb,
              (v) => ({ library: { cacheMaxGb: v } }),
              { min: 1, max: 50, step: 1, format: (v) => `${v} GB` }
            ),
            'Streamed audio stays on disk so replays start instantly and downloading a cached track is just a copy.',
            'disk storage space gb'
          )
        ]
      }
    ]
  },
  {
    id: 'interface',
    title: 'Interface',
    icon: <Monitor />,
    blurb: 'Scale, motion, blur, titles and the visualizer.',
    groups: [
      {
        title: 'Display',
        rows: [
          row(
            'uiscale',
            'UI scale',
            sliderRow(
              (s) => s.interface.uiScale,
              (v) => ({ interface: { uiScale: Math.round(v * 100) / 100 } }),
              { min: 0.8, max: 1.5, step: 0.05, format: pct }
            ),
            'Applied when you let go of the slider.',
            'zoom size bigger smaller text'
          ),
          row(
            'blur',
            'Blur quality',
            segRow(
              (s) => s.interface.blurQuality,
              (v) => ({ interface: { blurQuality: v } }),
              [
                { value: 'low', label: 'Low', description: 'Cheaper backdrops. Try this on integrated graphics.' },
                { value: 'high', label: 'High', description: 'Soft, wide blur behind panels and background art.' }
              ]
            ),
            'Background and panel blur.',
            'performance gpu backdrop'
          ),
          row(
            'dim',
            'Background dim',
            sliderRow(
              (s) => s.interface.backgroundDim,
              (v) => ({ interface: { backgroundDim: v } }),
              { min: 0, max: 0.9, step: 0.05, format: pct }
            ),
            'How much the game art behind Browse is darkened.',
            'brightness darken art background'
          ),
          row(
            'vis',
            'Visualizer',
            segRow(
              (s) => s.interface.visualizer,
              (v) => ({ interface: { visualizer: v } }),
              [
                { value: 'radial', label: 'Radial', description: 'A spectrum ring around the cover disc.' },
                { value: 'skyline', label: 'Skyline', description: 'A spectrum skyline along the bottom of the Play screen.' },
                { value: 'scope', label: 'Scope', description: 'An oscilloscope trace of the waveform.' }
              ]
            ),
            'Style on the Play screen.',
            'spectrum oscilloscope radial skyline scope play screen'
          )
        ]
      },
      {
        title: 'Motion',
        rows: [
          row(
            'parallax',
            'Parallax',
            toggleRow(
              (s) => s.interface.parallax,
              (v) => ({ interface: { parallax: v } }),
              { disabled: (s) => s.interface.reduceMotion }
            ),
            'Background and panels drift slightly with the mouse.',
            'mouse movement depth'
          ),
          row(
            'reduce',
            'Reduce motion',
            toggleRow(
              (s) => s.interface.reduceMotion,
              (v) => ({ interface: { reduceMotion: v } })
            ),
            'Shortens slides and turns off beat pulses and drifting.',
            'animation accessibility vestibular calm'
          )
        ]
      },
      {
        title: 'Text',
        rows: [
          row(
            'orig',
            'Prefer original-language titles',
            toggleRow(
              (s) => s.interface.preferOriginalTitles,
              (v) => ({ interface: { preferOriginalTitles: v } }),
              {
                description: () => (
                  <>
                    <Highlight text="Show titles like クロノ・トリガー instead of romanized ones. Toggle any time with" /> <Kbd combo="Alt+J" size="sm" />
                  </>
                )
              }
            ),
            'Show titles in their original script instead of romanized ones. Toggle any time with Alt+J.',
            'japanese romaji romanized language kanji'
          )
        ]
      },
      {
        title: 'Debug',
        rows: [
          row(
            'fps',
            'Show FPS',
            toggleRow(
              (s) => s.interface.showFps,
              (v) => ({ interface: { showFps: v } }),
              {
                description: () => (
                  <>
                    <Highlight text="Frame-time meter in the corner." /> <Kbd combo="Mod+Shift+F" size="sm" />
                  </>
                )
              }
            ),
            'Frame-time meter in the corner.',
            'fps frame rate performance meter counter'
          )
        ]
      }
    ]
  },
  {
    id: 'integrations',
    title: 'Integrations',
    icon: <Plug />,
    blurb: 'Optional keys for richer game art and metadata.',
    groups: [
      {
        title: 'Keys',
        rows: [
          { id: 'keysnote', label: 'Keys stay on this machine', keywords: 'privacy local api key', C: KeysNote },
          { id: 'igdb', label: 'IGDB', description: 'Game metadata and cover art.', keywords: 'igdb twitch client id secret metadata covers api key', C: IgdbRow },
          { id: 'sgdb', label: 'SteamGridDB', description: 'Hero images, logos and covers.', keywords: 'steamgriddb steam grid hero background art api key', C: SteamGridRow }
        ]
      }
    ]
  },
  {
    id: 'catalog',
    title: 'Catalog',
    icon: <Database />,
    blurb: 'The index of every game, album and track GHOST knows about.',
    groups: [{ title: 'Index', rows: [{ id: 'catalog', label: 'Catalog index', description: 'Games, albums and tracks indexed.', keywords: 'reindex re-index refresh update crawl games albums tracks', C: CatalogPanel }] }]
  },
  {
    id: 'about',
    title: 'About',
    icon: <Info />,
    blurb: 'Version, data folder and keyboard shortcuts.',
    groups: [
      {
        title: 'GHOST',
        rows: [
          {
            id: 'about',
            label: 'About GHOST',
            description: 'Version, data folder, keyboard shortcuts, credits.',
            keywords: `version data folder credits keyboard shortcuts keys hotkeys ${SHORTCUTS.map((s) => s.label).join(' ')}`,
            C: AboutPanel
          }
        ]
      }
    ]
  }
]

/** Does a row match the (lower-case) query? Every word must appear somewhere. */
export function rowMatches(r: RowDef, section: SectionDef, group: GroupDef, q: string): boolean {
  if (!q) return true
  const hay = `${r.label} ${r.description ?? ''} ${r.keywords ?? ''} ${group.title} ${section.title}`.toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}
