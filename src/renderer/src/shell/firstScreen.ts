// The first frame with a screen's content in it (the title screen, a filled Browse carousel or
// Play, not a loading ring). Startup work the first screen doesn't need waits for `firstScreen`,
// e.g. the GPU background: Pixi and its WebGL context set-up block the main thread on the GPU
// process, which on a cold start held the first frame back by hundreds of ms.
// `ghost:first-screen` is also the launch milestone scripts/perf/coldstart.mjs reads.

const SCREEN = '.tl-root, .bc-item, .pl-root'
/** Never hold dependent work back longer than this (an empty catalog, a screen that errored). */
const LIMIT_MS = 2500

let resolveFirst: () => void = () => {}
export const firstScreen = new Promise<void>((resolve) => (resolveFirst = resolve))

export function watchFirstScreen(): void {
  const root = document.getElementById('root')
  if (!root) return resolveFirst()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    mo.disconnect()
    window.clearTimeout(limit)
    requestAnimationFrame(() => {
      performance.mark('ghost:first-screen')
      // after this frame is out, not inside it
      window.setTimeout(resolveFirst, 0)
    })
  }
  const mo = new MutationObserver(() => {
    if (root.querySelector(SCREEN)) finish()
  })
  mo.observe(root, { childList: true, subtree: true })
  const limit = window.setTimeout(finish, LIMIT_MS)
}
