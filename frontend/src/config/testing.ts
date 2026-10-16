import { DATA_FEATURES, FEATURES, type FeatureId, type FeatureInfo } from './features'

/**
 * Changes registry entries for a test and puts them back. The registry is
 * module state, so a test that makes a feature "connected" must restore it
 * (call `restore` in afterEach) or every later test would see it.
 */
export function registryOverrides() {
  const original = new Map<FeatureId, FeatureInfo>()
  return {
    set(id: FeatureId, change: Partial<FeatureInfo>) {
      if (!original.has(id)) original.set(id, FEATURES[id])
      FEATURES[id] = { ...FEATURES[id], ...change }
    },
    /** Every feature the screens show is served by the console API and read by them: the app is fully live. */
    connectAll() {
      for (const id of DATA_FEATURES) this.set(id, { backend: 'console-api', connected: true })
    },
    restore() {
      for (const [id, info] of original) FEATURES[id] = info
      original.clear()
    },
  }
}
