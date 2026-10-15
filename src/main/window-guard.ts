// What the main window may navigate to and which links may leave the app. Pure (no Electron), so
// it is unit-tested; src/main/index.ts wires it to `setWindowOpenHandler` and `will-navigate`.

/** The only links handed to the OS (default browser / mail client). Never file:, custom schemes or javascript:. */
export function isExternalLink(url: string): boolean {
  return /^(https?:|mailto:)/i.test(String(url))
}

/**
 * Matcher for the app's own pages: same origin as the dev server URL, or the bundled index.html
 * (any query / hash). Anything else would replace the app, and inherit the window.ghost bridge.
 */
export function appPageMatcher(rendererUrl: string): (target: string) => boolean {
  if (!URL.canParse(rendererUrl)) return () => false
  const app = new URL(rendererUrl)
  if (app.protocol === 'file:') {
    return (t) => {
      if (!URL.canParse(t)) return false
      const u = new URL(t)
      return u.protocol === 'file:' && u.pathname === app.pathname
    }
  }
  return (t) => URL.canParse(t) && new URL(t).origin === app.origin
}

/** What to do with a navigation of the main window: stay (the app itself), open it outside, or drop it. */
export function navigationAction(target: string, isAppPage: (t: string) => boolean): 'allow' | 'external' | 'block' {
  if (isAppPage(target)) return 'allow'
  return isExternalLink(target) ? 'external' : 'block'
}
