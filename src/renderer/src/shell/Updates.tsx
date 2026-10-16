// GHOST's own updates, the dialogs: the update prompt (the toolbar pill and Settings open it, and it
// opens by itself the first time this session that a release waits for the user) and, once after
// an update, What's new. Both wait for the first screen; their chunk loads when one first opens.
// (Main toasts each step with its version too; the toolbar pill is in Toolbar.tsx.)
import { useEffect, useState } from 'react'
import type { WhatsNew } from '@shared/types'
import { openUpdatePrompt, updatesApi, useUpdates, useUpdateUI } from '../state/updates'
import { firstScreen } from './firstScreen'
import { lazyModule, useLazyModule } from './lazyModule'
import type { UpdateDialogsProps } from './UpdateDialogs'

const dialogs = lazyModule<UpdateDialogsProps>(() => import('./UpdateDialogs'))

/** Releases the prompt has been shown for this session (by itself or not). */
const prompted = new Set<string>()
/** Let the first screen, or What's new closing, settle before the prompt pops up. */
const PROMPT_DELAY_MS = 900

export function UpdatesHost() {
  const prompt = useUpdateUI((s) => s.prompt)
  const waiting = useUpdates((s) => s.status === 'available' && !s.dismissed)
  const version = useUpdates((s) => s.latest?.version ?? null)
  /** The first screen is up and What's new was asked for. */
  const [settled, setSettled] = useState(false)
  const [news, setNews] = useState<WhatsNew | null>(null)
  const [newsOpen, setNewsOpen] = useState(false)

  useEffect(() => {
    let live = true
    void firstScreen.then(async () => {
      const w = (await updatesApi()?.whatsNew().catch(() => null)) ?? null
      if (!live) return
      if (w) {
        setNews(w)
        setNewsOpen(true)
      }
      setSettled(true)
    })
    return () => {
      live = false
    }
  }, [])

  // a release that waits for the user (auto updates off, or an install that can't update itself):
  // ask once per version and session. "Not now" (dismiss) stops it for good; Esc only closes.
  useEffect(() => {
    if (!version) return
    if (prompt) {
      prompted.add(version)
      return
    }
    if (!settled || newsOpen || !waiting || prompted.has(version)) return
    const t = window.setTimeout(() => {
      prompted.add(version)
      openUpdatePrompt()
    }, PROMPT_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [settled, newsOpen, waiting, version, prompt])

  const closeNews = () => {
    setNewsOpen(false)
    void updatesApi()?.whatsNewSeen().catch(() => {})
  }

  // mounted from the first open on (the dialogs animate out on close)
  if (!prompt && !newsOpen && !dialogs.loaded) return null
  return <DialogsLoader prompt={prompt} news={news} newsOpen={newsOpen} onCloseNews={closeNews} />
}

function DialogsLoader(props: UpdateDialogsProps) {
  const Dialogs = useLazyModule(dialogs)
  return Dialogs ? <Dialogs {...props} /> : null
}
