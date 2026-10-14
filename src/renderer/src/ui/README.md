# GHOST UI kit, motion, beat, sound & theme

Everything the screens and overlays are built from. Open **http://localhost:5173/?kit** for a
live gallery of every component and state (source: `ui/Gallery.tsx`).

```ts
import { Button, ShearButton, IconButton, Slider, CoverArt, IntensityBadge, OverlayHeader, … } from '../../ui'
import { tween, stagger, Spring, useTicker, frame, beat, usePulse, useBeat, levels, useAudioLevels } from '../../motion'
import { sfx } from '../../sound'
import { useKeybinding, useScreenTransitions, notify, navigate, goBack } from '../../shell'
import { HUES, accentNow, mix, normalizeAccent } from '../../theme'
import { useIdle, useNowPlayingBackground } from '../../hooks'
```

## Rules of the house

1. **No React state per frame.** Anything that moves every frame goes through `useTicker` /
   `tween` / `Spring` and writes `transform`, `opacity` or a CSS variable directly.
2. **One loop.** Never call `requestAnimationFrame` yourself; use `ticker.add` / `useTicker`.
3. **Read analysis via `frame()`** (cached once per frame), never `ghost().analysis.read()`.
4. **Colours come from tokens** (`var(--fg-2)`, `rgb(var(--accent-rgb) / .2)`), never hex
   literals for themeable things. The accent glides when it changes; your UI follows for free.
5. **Sound comes with the kit.** Buttons already play hover/select; only call `sfx` for
   custom interactions.
6. **Reduced motion is automatic** for `tween`, `Spring`, `usePulse` and the background.
   If you hand-roll a ticker animation, check `motionPrefs.reduce`.

---

## Theme (`theme/`)

Tokens live in `theme/tokens.css`. The ones you'll use most:

| Token | Use |
|---|---|
| `--bg-0 … --bg-5`, `--bg-2-rgb` | plum-navy surfaces, deepest → raised |
| `--glass-1`, `--glass-2`, `--glass-line` | translucent panels over the animated background |
| `--fg-0 … --fg-4` | text: white → primary → secondary → muted → disabled |
| `--line-1 … --line-3` | hairlines |
| `--accent`, `--accent-rgb`, `--accent-hi`, `--accent-lo`, `--accent-ink` | live accent (game colour); `-ink` is text on an accent fill |
| `--hue-browse/library/downloads/settings/radio/notifications` (+ `-rgb`) | per-section hues |
| `--success/--warning/--danger/--info` (+ `-rgb`) | semantic |
| `--radius-sm/--radius/--radius-lg/--radius-pill` | 6 / 10 / 14 / 999 px |
| `--shear` / `--unshear` | lazer shear: `transform: skewX(var(--shear))` on the panel, `skewX(var(--unshear))` on its content |
| `--shadow-1..3`, `--shadow-pop`, `--glow-accent(-strong)` | depth |
| `--ease-out-quint`, `--ease-out-back`, `--dur-hover`, `--dur-slide` | CSS transitions |
| `--fs-2xs … --fs-display`, `--fw-*` | type scale (Outfit Variable + M PLUS Rounded 1c) |
| `--toolbar-h` | 44 px; pad your screen's top by it |
| `--z-*` | layers: screen 10 · overlay 50 · toolbar 60 · toast 80 · dialog 90 · menu 100 · tooltip 110 |

Helper classes: `.tnum` (tabular numerals for times), `.g-ellipsis`, `.g-caps`, `.g-muted`,
`.g-shear` / `.g-unshear`, `.g-selectable` (opt into text selection), `.g-jp`.

**Accent.** `useUI.getState().setAccent(hex)` sets the target; `theme/accent.ts` interpolates
it in OKLab over 600 ms and normalises it for legibility (so dull art colours still work).
The shell sets it whenever the current track changes; Browse sets it on selection.
For canvas/Pixi code, read the live value: `accentNow.rgb` / `accentNow.number` / `accentNow.hex`.

**Hue a subtree:** every kit component takes `hue` (`'library'` or `'#5aa8ff'`); for your own
markup use `style={hueStyle('library')}` and everything inside that reads `--accent` takes it.

**Background:** `useUI.getState().setBackground(rawArtUrl, { dim: 0.55, blur: 1 })`. The
GPU layer pre-blurs once, cross-fades and drifts it. `blur` 0..1 mixes sharp ↔ blurred (cheap).
Screens showing the now-playing art can just call `useNowPlayingBackground({ dim, blur })`.
Note: the shell updates the background on track change **except while Browse is active**
(Browse owns its background then).

---

## Motion (`motion/`)

### Ticker
```ts
useTicker((dt, now) => { el.style.transform = `rotate(${(now / 20) % 360}deg)` })   // component lifetime
const off = ticker.add((dt, now) => …, TickPriority.normal)                            // imperative
```
`dt` is ms since the last frame (clamped to 100), `now` the rAF timestamp. Priorities run
input → audio → physics → normal → tween → render. The loop sleeps when idle/hidden.

### Tweens (osu!framework transforms)
```ts
tween(el).fadeTo(1, 300, 'outQuint').moveTo(40, 0, 400)          // run together
tween(el).moveToX(-20, 200).then().fadeOut(300)                    // .then() = sequence
tween(el).delay(120).scaleTo(1.05, 200, 'outBack')
tween(el).set({ opacity: 0, x: 30 }).fadeIn(250).moveToX(0, 450)   // set = instant (no flash)
await tween(el).fadeOut(250)                                       // thenable
tween(el).then(() => el.remove())                                  // callback when done
tween(el).clear()                                                  // stop (pending callbacks fire)
await stagger(rows, (t, i) => t.set({ opacity: 0, x: 40 }).fadeIn(300).moveToX(0, 500), 35)
animateValue({ from: 0, to: 1, duration: 600, onUpdate: (v) => (sprite.alpha = v) })
```
Methods: `fadeTo/fadeIn/fadeOut`, `moveTo/moveToX/moveToY` (px), `scaleTo(n | [sx, sy])`,
`rotateTo(deg)`, `shearTo(rad)`, `blurTo(px)`, `set({...})`, `delay(ms)`, `call(fn)`,
`then()`, `.finished`. Re-targeting a property mid-flight is seamless. The tween owns the
element's inline `transform`: if a CSS class also transforms that element (e.g. a
`ShearButton`'s skew), tween a **wrapper** instead. `usePulse` writes the separate CSS
`scale` property, so it composes with tweens.

**Easings:** the full Penner set by name: `linear`, `in/out/inOut` × `Quad Cubic Quart Quint
Sine Expo Circ Back Elastic Bounce`, plus `outPow10`, `outElasticHalf`, `outElasticQuarter`.
House style: `outQuint` (default) for everything; 200 ms hover, 300–500 ms slides;
`outElasticHalf`/`outBack` for pops. CSS equivalents: `var(--ease-out-quint)` etc.

### Springs
```ts
const s = new Spring({ value: 0, frequency: 3, damping: 0.8 })   // Hz, damping ratio
s.drive((v) => (el.style.transform = `translateY(${v}px)`))      // ticks only while moving
s.to(120); s.impulse(-900); s.set(0)
```

### Music: `frame()`, `levels`, `beat`
```ts
useTicker(() => {
  const f = frame()              // AnalysisFrame | null: 96 bands, waveform, rms, onset, positionMs
  if (f) draw(f.bands)
})
useAudioLevels()                 // keep `levels` updating while mounted
levels.level / levels.bass / levels.mid / levels.high / levels.onset   // smoothed 0..1

beat.phase      // 0..1 through the current beat
beat.pulse      // 0..~1.6 envelope: jumps on a beat, OutQuint decay over 80% of it
beat.index, beat.isDownbeat, beat.inKiai, beat.kiai (smoothed 0..1), beat.bpm, beat.beatLength, beat.hasGrid
useBeat((e) => { if (e.downbeat) flash() })          // e: { index, downbeat, kiai, bpm, beatLength, strength, fromOnset }
const kiai = useKiai()                                // React state; re-renders only on change
```
The clock uses the offline beat grid against `livePositionMs()`; tracks without a grid fall
back to onset peaks (`e.fromOnset`). Read `beat.*` inside ticker callbacks after calling
`beat.retain()` (hooks below do it for you).

### Pulse
```ts
usePulse(ref)                                   // scale 1 → 1.04 on beats (downbeats/kiai stronger)
usePulse(ref, { amount: 0.02 })
usePulse(glowRef, { mode: 'var' })             // writes --pulse (0..1.6) for CSS: opacity: calc(.5 + var(--pulse) * .3)
```

---

## Components (`ui/`)

| Component | Notes |
|---|---|
| `Button` | `variant` primary · secondary · soft · ghost · danger; `size` sm · md · lg; `icon`, `iconRight`, `loading`, `block`, `hue`, `sound` |
| `ShearButton` | lazer footer button: `label`, `hint`, `icon`, `hue`, `active`, `size` (lg for menus), `soft` (looks disabled, still hoverable) |
| `IconButton` | `icon`, `label` (aria + tooltip), `shortcut`, `active`, `variant` plain · solid · subtle, `size` sm…xl, `round` |
| `Panel` / `Wedge` | glass surface; `sheared`, `interactive` (hover 1.02), `selected` (accent edge glow), `glow`; `Wedge side="left"` bleeds off the screen edge |
| `Slider` | `value`/`onChange`/`onCommit`, `min`/`max`/`step`, `variant` default · seek · volume, `format` (hover tooltip), `buffered`, `background` (e.g. energy curve). **`live={() => livePositionMs()}`** updates at 120 fps without re-renders. Drag, wheel, arrows/PageUp/Home/End |
| `Toggle` | `checked`/`onChange`; with `label`/`description` it renders a settings row |
| `Select` | `value`, `options [{ value, label, icon?, hint? }]`, `onChange`, `prefix` ("sort:") — keyboard + type-ahead |
| `SegmentedControl` | sliding indicator; `options`, `value`, `onChange`, `sheared`, `block` |
| `SearchInput` | `value`/`onChange`/`onSubmit`/`onEscape`, `highlight={(text) => <spans/>}` render-prop (must reproduce the text exactly), `loading`, `right`, `size="lg"`; ref → `{ focus, blur, select, input }`. Esc clears, then blurs |
| `Tooltip` | `<Tooltip content="…" shortcut="Mod+L" side="top"><button/></Tooltip>` (child must take a ref) |
| `ContextMenu` | `<ContextMenu items={() => MenuItem[]}>child</ContextMenu>`, or `openContextMenu({ x, y }, items)`. Items: `{ label, icon, shortcut, onSelect, danger, checked, disabled, submenu }`, `{ separator: true }`, `{ heading }` |
| `Dialog` | `<Dialog open onClose title icon footer hue width bare>`; imperative `await confirmDialog({ title, body, confirmLabel, danger })` → boolean, `await promptDialog({ title, label, defaultValue, validate })` → string \| null |
| `LoadingRing` | `size`, `box` (osu! dark tile), `label`, `center` (fills positioned parent, fades in) |
| `ProgressRing` | `value` 0..1 or `null` (indeterminate), `size`, `thickness`, children in the middle |
| `IntensityBadge` | `value` stars (0..10 / null), `size`, `glow` — osu! difficulty colours via `intensityColor` |
| `SourceBadge` | `source` (SourceSummary or format) → FLAC / 320 / CHIP / YT |
| `CoverArt` | `src` (raw URL; `artUrl` applied), `size`, `height`, `radius`, `hue` (fallback tint). Fades in, cross-fades on change, ghost fallback |
| `Marquee` | scrolls only when it overflows; `speed`, `paused`, `pauseOnHover` |
| `Kbd` | `<Kbd combo="Mod+Shift+L"/>` → ⌘ ⇧ L on macOS, Ctrl Shift L elsewhere |
| `ScrollArea` | smooth wheel (mouse only, trackpads stay native), fade edges; `viewportRef`; `scrollToSmooth(el, y)` |
| `OverlayHeader` | standard overlay title row: `icon`, `title`, `description`, `actions`; tinted by the overlay hue automatically |
| `GhostMark` | the brand mark (currentColor), for empty states |
| `formatTime(ms)` | `83000 → "1:23"` |

---

## Shell contracts (`shell/`)

**Screens** (`screens/<id>/index.tsx`) default-export `(props: ScreenProps) => JSX`:
```ts
props.lifecycle  // 'entering' | 'active' | 'exiting'
props.direction  // 'forward' | 'back'
props.from / props.to
useScreenTransitions({
  enter: ({ direction, other, el }) => stagger(…),   // may return a promise / tween
  exit:  ({ direction, other, el }) => stagger(…),   // awaited (max 1 s) before unmount
})
```
Without `useScreenTransitions` the stack slides + fades the whole screen. Choreograph with
staggered slides, never plain cross-fades. Screens are full-window and sit under the 44 px
toolbar (`padding-top: var(--toolbar-h)`); on Play the toolbar auto-hides.

**Overlays** (`overlays/<id>/index.tsx`) default-export `(props: OverlayProps) => JSX`:
`{ open, phase, close(), hue }`. The host draws the panel (slide-in, hue as `--accent`,
backdrop, focus trap, Esc/click-outside, open/close whoosh, music low-pass for modal ones).
Fill it with `<OverlayHeader/>` + a `ScrollArea`. Overlays stay mounted once opened: pause
tickers when `!open`. Library/Downloads slide from the right, Settings from the left,
Now Playing drops from its toolbar chip.

**Navigation:** `navigate('browse')` (with sound), `goBack()`, `useUI.getState().toggleOverlay('library', true)`.
Deep links: `?screen=title|browse|play`, `?overlay=library|settings|downloads|nowPlaying|notifications`, `?kit`.

**Keys:**
```ts
useKeybinding('Mod+D', download)                         // scope = enclosing screen/overlay
useKeybinding(['ArrowDown', 'J'], next)                   // repeats by default
useKeybinding('Escape', () => (open ? close() : false))   // return false = not handled, pass on
useKeybinding('F2', random, { scope: 'global', repeat: false, allowInInput: false, priority: 10 })
```
Precedence: modal dialog > overlay (top-most only) > screen (active, no modal overlay) >
global; then `priority`, then most recent. Typing in inputs never triggers plain-letter
bindings. If your component consumes a key itself, `e.preventDefault()` it. Global keys:
Space play/pause · Mod+←/→ prev/next · Mod+L library · Mod+O settings · F6 now playing ·
Esc close overlay / back · Mod+Shift+F FPS meter.

**Notifications:** `notify({ kind: 'success' | 'info' | 'error' | 'progress', title, body?, progress?, image?, id? })`.
Re-sending the same `id` updates that card in place and restarts its timer.

---

## Sound (`sound/`)

```ts
sfx.play('hover' | 'select' | 'back' | 'confirm' | 'open' | 'close' | 'notify' |
         'toggleOn' | 'toggleOff' | 'tick' | 'error' | 'expand' | 'collapse', { volume?: 0..1 })
```
Synthesised (Web Audio), D-major pentatonic, ≈ −18 dBFS, throttled per cue, honours
`settings.audio.uiSounds` / `uiSoundVolume`. Kit components already play hover + select;
use `sound={false}` / `sound="confirm"` on them to change that.
