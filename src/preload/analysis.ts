// Synchronous analysis-frame reader for the renderer.
// The engine (main process) publishes frames into a shared-memory region; the preload maps
// it through the same native addon and copies the latest frame out on every read().
// Main passes the addon path and region name as additionalArguments:
//   --ghost-native=<abs path to .node>  --ghost-shm=<region name>
import type { AnalysisAPI } from '../shared/api'

export function createAnalysisReader(): AnalysisAPI {
  // Implemented by the engine-bindings workstream. Until then: no frames.
  return { read: () => null }
}
