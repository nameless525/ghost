// osu!-style screen stack with choreographed transitions.
//
// When useUI.screen changes, the current screen gets lifecycle 'exiting' and the new one
// mounts with 'entering'; both run at once. Each screen may take over its own choreography:
//
//   useScreenTransitions({
//     enter: ({ direction }) => stagger(rows, (t) => t.set({ opacity: 0, x: 40 }).fadeIn(300).moveToX(0, 500), 35),
//     exit:  ({ direction }) => stagger(rows, (t) => t.fadeOut(200).moveToX(-60, 300, 'inQuint'), 25),
//   })
//
// Without it the stack slides/fades the whole screen. Exits are awaited (max 1 s) before
// the screen unmounts; enters flip lifecycle to 'active' when they finish (max 1.2 s).
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent
} from 'react'
import { tween } from '../motion/tween'
import { anyModalOverlay, useUI, type ScreenId } from '../state/ui'
import { LoadingRing } from '../ui/LoadingRing'
import { cx } from '../ui/util'
import { ErrorBoundary } from './ErrorBoundary'
import { KeyScopeContext, type KeyScopeValue } from './keys'
import { screenDepth } from './navigation'
import type { NavDirection, ScreenLifecycle, ScreenProps } from './types'

const loaders: Record<ScreenId, () => Promise<{ default: ComponentType<ScreenProps> }>> = {
  title: () => import('../screens/title'),
  browse: () => import('../screens/browse'),
  play: () => import('../screens/play')
}

const SCREENS: Record<ScreenId, LazyExoticComponent<ComponentType<ScreenProps>>> = {
  title: lazy(loaders.title),
  browse: lazy(loaders.browse),
  play: lazy(loaders.play)
}

const SCREEN_LABELS: Record<ScreenId, string> = { title: 'The title screen', browse: 'Browse', play: 'The player' }

/** Warm the chunk for a screen (e.g. on hover of a button that navigates there). */
export function preloadScreen(id: ScreenId): void {
  void loaders[id]().catch(() => {})
}

export interface TransitionContext {
  direction: NavDirection
  /** On enter: where we came from. On exit: where we're going. */
  other: ScreenId | null
  /** The screen's container element. */
  el: HTMLElement
}

type TransitionFn = (ctx: TransitionContext) => void | Promise<unknown> | PromiseLike<unknown>

export interface ScreenTransitions {
  enter?: TransitionFn
  exit?: TransitionFn
}

const TransitionsContext = createContext<{ current: ScreenTransitions } | null>(null)
const ScreenContext = createContext<ScreenProps>({ lifecycle: 'active', direction: 'forward', from: null, to: null })

/** Register custom enter/exit choreography for the current screen (see file header). */
export function useScreenTransitions(t: ScreenTransitions): void {
  const reg = useContext(TransitionsContext)
  // registered during layout so it's in place before the stack starts the enter
  useLayoutEffect(() => {
    if (!reg) return
    reg.current = t
  })
}

/** The current screen's lifecycle props, from anywhere inside it. */
export function useScreen(): ScreenProps {
  return useContext(ScreenContext)
}

interface Entry {
  key: number
  id: ScreenId
  lifecycle: ScreenLifecycle
  direction: NavDirection
  from: ScreenId | null
  to: ScreenId | null
}

// Keys derive from the current list (not a module counter) so they stay unique even if this module is
// re-executed by hot reload while React keeps the existing entries.
const nextKey = (list: Entry[]) => list.reduce((m, e) => Math.max(m, e.key), 0) + 1
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

export function ScreenStack() {
  const screen = useUI((s) => s.screen)
  const [entries, setEntries] = useState<Entry[]>(() => [{ key: 1, id: screen, lifecycle: 'entering', direction: 'forward', from: null, to: null }])

  useEffect(() => {
    setEntries((list) => {
      const live = list.filter((e) => e.lifecycle !== 'exiting')
      const top = live[live.length - 1]
      if (top?.id === screen) return list
      const direction: NavDirection = !top || screenDepth(screen) >= screenDepth(top.id) ? 'forward' : 'back'
      const next = list.map((e) => (e.lifecycle !== 'exiting' ? { ...e, lifecycle: 'exiting' as const, direction, to: screen } : e))
      return [...next, { key: nextKey(list), id: screen, lifecycle: 'entering', direction, from: top?.id ?? null, to: null }]
    })
  }, [screen])

  // warm the other screens once the first one is up
  useEffect(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 800))
    idle(() => (Object.keys(loaders) as ScreenId[]).forEach(preloadScreen))
  }, [])

  return (
    <div className="g-screens">
      {entries.map((e) => (
        <ScreenFrame
          key={e.key}
          entry={e}
          onEntered={() => setEntries((l) => l.map((x) => (x.key === e.key && x.lifecycle === 'entering' ? { ...x, lifecycle: 'active' } : x)))}
          onExited={() => setEntries((l) => l.filter((x) => x.key !== e.key))}
        />
      ))}
    </div>
  )
}

function MountProbe({ onMount }: { onMount: () => void }) {
  useLayoutEffect(onMount, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const SLIDE = 72

function defaultEnter(el: HTMLElement, dir: NavDirection): Promise<void> {
  const from = dir === 'forward' ? SLIDE : -SLIDE
  return tween(el)
    .clear()
    .set({ opacity: 0, x: from, scale: dir === 'forward' ? 1.02 : 0.98 })
    .fadeIn(320, 'outQuad')
    .moveToX(0, 650, 'outQuint')
    .scaleTo(1, 650, 'outQuint').finished
}

function defaultExit(el: HTMLElement, dir: NavDirection): Promise<void> {
  const to = dir === 'forward' ? -SLIDE : SLIDE
  return tween(el).clear().fadeOut(260, 'outQuad').moveToX(to, 420, 'inQuad').scaleTo(dir === 'forward' ? 0.98 : 1.02, 420, 'inQuad').finished
}

function ScreenFrame({ entry, onEntered, onExited }: { entry: Entry; onEntered: () => void; onExited: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  const transitions = useRef<ScreenTransitions>({})
  const mounted = useRef(false)
  const lifecycle = useRef(entry.lifecycle)
  lifecycle.current = entry.lifecycle
  const Screen = SCREENS[entry.id]

  const props: ScreenProps = useMemo(
    () => ({ lifecycle: entry.lifecycle, direction: entry.direction, from: entry.from, to: entry.to }),
    [entry.lifecycle, entry.direction, entry.from, entry.to]
  )

  const scope = useMemo<KeyScopeValue>(
    () => ({ scope: 'screen', id: entry.id, isActive: () => lifecycle.current !== 'exiting' && !anyModalOverlay(useUI.getState()) }),
    [entry.id]
  )

  const runEnter = () => {
    const node = el.current
    if (!node || lifecycle.current === 'exiting') return
    mounted.current = true
    const ctx: TransitionContext = { direction: entry.direction, other: entry.from, el: node }
    let p: unknown
    try {
      p = transitions.current.enter ? transitions.current.enter(ctx) : defaultEnter(node, entry.direction)
    } catch (err) {
      console.error('[screens] enter threw', err)
    }
    void Promise.race([Promise.resolve(p).catch(() => {}), wait(1200)]).then(() => {
      // drop the settled transform so position:fixed children aren't trapped
      if (!transitions.current.enter && lifecycle.current !== 'exiting' && !tween.isActive(node)) node.style.transform = ''
      if (lifecycle.current === 'entering') onEntered()
    })
  }

  useEffect(() => {
    if (entry.lifecycle !== 'exiting') return
    const node = el.current
    if (!node) return onExited()
    const ctx: TransitionContext = { direction: entry.direction, other: entry.to, el: node }
    let p: unknown
    try {
      p = mounted.current && transitions.current.exit ? transitions.current.exit(ctx) : defaultExit(node, entry.direction)
    } catch (err) {
      console.error('[screens] exit threw', err)
    }
    let done = false
    void Promise.race([Promise.resolve(p).catch(() => {}), wait(1000)]).then(() => {
      if (done) return
      done = true
      onExited()
    })
    return () => {
      done = true
    }
  }, [entry.lifecycle]) // eslint-disable-line react-hooks/exhaustive-deps

  const registry = useMemo(() => transitions, [])

  return (
    <div
      ref={el}
      className={cx('g-screen', `g-screen--${entry.id}`, entry.lifecycle === 'exiting' && 'g-screen--exiting')}
      data-screen={entry.id}
      data-lifecycle={entry.lifecycle}
      aria-hidden={entry.lifecycle === 'exiting' || undefined}
    >
      <KeyScopeContext.Provider value={scope}>
        <TransitionsContext.Provider value={registry}>
          <ScreenContext.Provider value={props}>
            <ErrorBoundary label={SCREEN_LABELS[entry.id]}>
              <Suspense fallback={<LoadingRing center box />}>
                <Screen {...props} />
                <MountProbe onMount={runEnter} />
              </Suspense>
            </ErrorBoundary>
          </ScreenContext.Provider>
        </TransitionsContext.Provider>
      </KeyScopeContext.Provider>
    </div>
  )
}
