import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { appPageMatcher, isExternalLink, navigationAction } from './window-guard'

describe('window guard', () => {
  it('only web and mail links leave the app', () => {
    for (const ok of ['https://example.com/x', 'http://localhost:1/', 'mailto:a@b.c', 'HTTPS://X.Y']) expect(isExternalLink(ok)).toBe(true)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'x-apple.systempreferences:com.apple.preference', 'ghost-art://img/?u=x', '', 'data:text/html,hi'])
      expect(isExternalLink(bad)).toBe(false)
  })

  it('the bundled app page (any query/hash) is the only file: page allowed', () => {
    const page = pathToFileURL('/Applications/GHOST.app/Contents/Resources/app/out/renderer/index.html').href
    const isApp = appPageMatcher(page)
    expect(isApp(page)).toBe(true)
    expect(isApp(`${page}?screen=browse#x`)).toBe(true)
    expect(isApp(pathToFileURL('/Users/me/Downloads/cover.png').href)).toBe(false)
    expect(isApp('https://evil.example/index.html')).toBe(false)
  })

  it('the dev server origin is the app in development', () => {
    const isApp = appPageMatcher('http://localhost:5174/')
    expect(isApp('http://localhost:5174/?kit')).toBe(true)
    expect(isApp('http://localhost:5175/')).toBe(false)
    expect(isApp('https://localhost:5174/')).toBe(false)
  })

  it('a dropped file or a followed link never replaces the app', () => {
    const isApp = appPageMatcher('http://localhost:5174/')
    expect(navigationAction('http://localhost:5174/', isApp)).toBe('allow')
    expect(navigationAction('file:///Users/me/Music/song.mp3', isApp)).toBe('block')
    expect(navigationAction('https://downloads.khinsider.com/', isApp)).toBe('external')
    expect(navigationAction('javascript:void 0', isApp)).toBe('block')
  })
})
