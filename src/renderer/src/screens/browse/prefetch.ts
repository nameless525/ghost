// Covers of the rows around a resting selection, fetched ahead so they're already in the art cache
// when the carousel gets there. They go out at background priority (`bg=1`: they only use the
// download capacity the covers on screen leave) and nothing is decoded here: the rows' own
// requests then come straight from the cache.
import { artUrl } from '../../lib/art'
import { browseModel } from './model'
import { GROUP_ART_W } from './panels'

const AHEAD = 14
const BEHIND = 4
const asked = new Set<string>()

export function prefetchCoversAround(gi: number): void {
  for (let i = Math.max(0, gi - BEHIND); i <= gi + AHEAD; i++) {
    const g = browseModel.group(i)
    const src = g ? artUrl(g.cover ?? g.hero, { w: GROUP_ART_W }) : null
    // only through the art protocol (the browser mock has no cache to warm)
    if (!src?.startsWith('ghost-art:') || asked.has(src)) continue
    if (asked.size >= 4000) asked.clear()
    asked.add(src)
    void fetch(`${src}&bg=1`)
      .then((r) => r.body?.cancel())
      .catch(() => {})
  }
}
