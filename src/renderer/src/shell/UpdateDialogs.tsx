// The update prompt and What's new (hosted by Updates.tsx, which loads this chunk on first open).
import { CircleFadingArrowUp, ExternalLink, Info, RotateCw, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { UpdateRelease, WhatsNew } from '@shared/types'
import { closeUpdatePrompt, dismissUpdate, installUpdate, openReleasePage, updateFraction, useUpdates, useUpdateUI } from '../state/updates'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Markdown } from '../ui/Markdown'
import { ProgressBar } from '../ui/ProgressBar'
import { ScrollArea } from '../ui/ScrollArea'

export interface UpdateDialogsProps {
  prompt: boolean
  news: WhatsNew | null
  newsOpen: boolean
  onCloseNews: () => void
}

const longDate = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/** "2026-10-15" (a changelog date) → "15 October 2026"; anything else as written. */
function changelogDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  return m ? longDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : s
}

const MB = 1024 * 1024
const mb = (n: number) => (n >= 100 * MB ? (n / MB).toFixed(0) : (n / MB).toFixed(1))

/** The release notes, scrollable. Focused when the dialog opens, so a key pressed as it pops up
 *  scrolls them instead of pressing a button. */
function Notes({ children }: { children: ReactNode }) {
  return (
    <div className="g-upd__well">
      <ScrollArea className="g-upd__notes" tabIndex={0}>
        {children}
      </ScrollArea>
    </div>
  )
}

function UpdatePrompt({ open }: { open: boolean }) {
  const s = useUpdates()
  const restarting = useUpdateUI((u) => u.restarting)
  // keep showing the release while the dialog animates out, whatever the state did meanwhile
  const last = useRef<UpdateRelease | null>(s.latest)
  useEffect(() => {
    if (s.latest) last.current = s.latest
  })
  // nothing to offer any more (a check found nothing newer)
  useEffect(() => {
    if (open && !s.latest) closeUpdatePrompt()
  }, [open, s.latest])
  const latest = s.latest ?? last.current
  if (!latest) return null

  const v = latest.version
  const ready = s.status === 'ready'
  const failed = s.status === 'error'
  // the download runs, or is about to ("Update now" was just clicked)
  const busy = s.status === 'downloading' || (restarting && !ready && !failed)
  const p = s.status === 'downloading' ? s.progress : null
  const total = p?.totalBytes ?? latest.sizeBytes
  const sub = [`You have GHOST ${s.current}`, latest.publishedAt ? `${v} came out on ${longDate(new Date(latest.publishedAt))}` : null, latest.sizeBytes && s.canInstall && !ready ? `${mb(latest.sizeBytes)} MB download` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <Dialog
      open={open}
      onClose={closeUpdatePrompt}
      icon={ready ? <RotateCw /> : <CircleFadingArrowUp />}
      width={580}
      bare
      title={
        <>
          {ready ? `GHOST ${v} is ready` : busy ? `Updating to GHOST ${v}` : `GHOST ${v} is available`}
          <div className="g-upd__sub">{sub}</div>
        </>
      }
      footer={
        <>
          {s.canInstall && (
            <Button variant="ghost" className="g-upd__page" icon={<ExternalLink />} onClick={() => openReleasePage(latest.url)}>
              Release page
            </Button>
          )}
          {ready ? (
            <>
              <Button variant="ghost" sound="back" onClick={closeUpdatePrompt}>
                Later
              </Button>
              <Button variant="primary" sound="confirm" disabled={restarting} onClick={installUpdate}>
                {restarting ? 'Restarting…' : 'Restart now'}
              </Button>
            </>
          ) : busy ? (
            <>
              <Button variant="ghost" sound="back" onClick={closeUpdatePrompt}>
                Close
              </Button>
              {restarting ? (
                <Button variant="primary" disabled>
                  Updating…
                </Button>
              ) : (
                <Button variant="primary" sound="confirm" onClick={installUpdate} tooltip="Restart into it as soon as it’s downloaded">
                  Update now
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="ghost" sound="back" onClick={dismissUpdate} tooltip={`Don’t ask about GHOST ${v} again`}>
                Not now
              </Button>
              {s.canInstall ? (
                <Button variant="primary" sound="confirm" onClick={installUpdate}>
                  {failed ? 'Try again' : 'Update now'}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<ExternalLink />}
                  onClick={() => {
                    openReleasePage(latest.url)
                    closeUpdatePrompt()
                  }}
                >
                  Download
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      <div className="g-dialog__body g-upd">
        {!s.canInstall && s.manualReason && (
          <div className="g-upd__note">
            <Info />
            <span>{s.manualReason}</span>
          </div>
        )}
        {failed && s.error && (
          <div className="g-upd__note g-upd__note--error">
            <TriangleAlert />
            <span>{s.error}</span>
          </div>
        )}
        <Notes>{latest.notes.trim() ? <Markdown source={latest.notes} /> : <p className="g-upd__empty">This release has no notes. The release page may say more.</p>}</Notes>
        {busy && (
          <div className="g-upd__progress">
            <ProgressBar
              caption
              progress={{ label: `Downloading GHOST ${v}`, detail: p && total ? `${mb(p.bytes)} of ${mb(total)} MB` : null, fraction: p ? updateFraction(s) : null, expectMs: null, since: 0 }}
              waitKey={v}
            />
            <div className="g-upd__after">{restarting ? 'GHOST restarts by itself when the download is done.' : 'It installs when you quit GHOST. Update now to restart into it as soon as it’s downloaded.'}</div>
          </div>
        )}
        {ready && <div className="g-upd__after">It installs when you quit GHOST, or restart now to install it straight away (what’s playing stops; your queue is still there after the restart).</div>}
      </div>
    </Dialog>
  )
}

function WhatsNewDialog({ news, open, onClose }: { news: WhatsNew; open: boolean; onClose: () => void }) {
  const many = news.sections.length > 1
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={<Sparkles />}
      width={580}
      bare
      title={
        <>
          What’s new in GHOST {news.version}
          {news.from && <div className="g-upd__sub">Updated from {news.from}</div>}
        </>
      }
      footer={
        <Button variant="primary" sound="confirm" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <div className="g-dialog__body g-upd">
        <Notes>
          {news.sections.length ? (
            news.sections.map((sec) => (
              <section key={sec.version} className="g-upd__section">
                {many && (
                  <h3 className="g-upd__ver">
                    GHOST {sec.version}
                    {sec.date && <span className="g-upd__date">{changelogDate(sec.date)}</span>}
                  </h3>
                )}
                <Markdown source={sec.notes} />
              </section>
            ))
          ) : (
            <p className="g-upd__empty">GHOST is now on version {news.version}. This version has no release notes.</p>
          )}
        </Notes>
      </div>
    </Dialog>
  )
}

export default function UpdateDialogs({ prompt, news, newsOpen, onCloseNews }: UpdateDialogsProps) {
  return (
    <>
      <UpdatePrompt open={prompt} />
      {news && <WhatsNewDialog news={news} open={newsOpen} onClose={onCloseNews} />}
    </>
  )
}
