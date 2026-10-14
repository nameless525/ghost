// Query helpers shared by the search bar, footer and screen (kept out of component modules
// so React Fast Refresh stays happy).
import { browseModel } from './model'
import { naturalQuery, useBrowse } from './store'

/** Apply the query to the model (debounced for typing, immediate for selectors). */
let queryTimer = 0
export function applyQuery(immediate = false): void {
  window.clearTimeout(queryTimer)
  const run = () => {
    const { text, group, sort } = useBrowse.getState()
    void browseModel.setQuery({ text: text.trim(), group, sort })
  }
  if (immediate) run()
  else queryTimer = window.setTimeout(run, 170)
}

export function setSearchText(text: string, immediate = false): void {
  useBrowse.setState({ text })
  applyQuery(immediate)
}

export function openExternalSearch(query?: string): void {
  const s = useBrowse.getState()
  useBrowse.setState({ externalOpen: true, externalQuery: (query ?? naturalQuery(s.text)).trim() || (s.sel?.group?.title ?? '') })
}

