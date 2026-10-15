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

/**
 * Open "Search online" (the web sources) for `query`, else for what's typed in the search box. With
 * neither, the dialog opens empty for the user to type a name.
 */
export function openSearchOnline(query?: string): void {
  useBrowse.setState({ externalOpen: true, externalQuery: (query ?? naturalQuery(useBrowse.getState().text)).trim() })
}

/** Add a filter / word to the query (search tips): appended, separated by a space. */
export function appendToQuery(token: string): string {
  const text = useBrowse.getState().text
  const next = text.trim() ? `${text.replace(/\s+$/, '')} ${token}` : token
  setSearchText(next, true)
  return next
}

