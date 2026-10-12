import { useCallback, useMemo, useState } from 'react'

/** Which series the legend has switched off. Colors never move: they follow the series id. */
export interface SeriesVisibility {
  hidden: ReadonlySet<string>
  /** Show or hide one series. Hiding the last visible series shows them all again. */
  toggle: (id: string) => void
  /** Show only this series; again on the lone visible series shows them all. */
  isolate: (id: string) => void
}

export function toggleHidden(
  hidden: ReadonlySet<string>,
  id: string,
  all: readonly string[],
): ReadonlySet<string> {
  const next = new Set(hidden)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  // An empty plot says nothing: hiding everything means "start over".
  return all.every((other) => next.has(other)) ? new Set() : next
}

export function isolateHidden(
  hidden: ReadonlySet<string>,
  id: string,
  all: readonly string[],
): ReadonlySet<string> {
  const alreadyIsolated = all.every((other) =>
    other === id ? !hidden.has(other) : hidden.has(other),
  )
  return alreadyIsolated ? new Set() : new Set(all.filter((other) => other !== id))
}

/** `ids` are the toggleable series, in a stable (module-level) array. */
export function useSeriesVisibility(ids: readonly string[]): SeriesVisibility {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback(
    (id: string) => setHidden((prev) => toggleHidden(prev, id, ids)),
    [ids],
  )
  const isolate = useCallback(
    (id: string) => setHidden((prev) => isolateHidden(prev, id, ids)),
    [ids],
  )
  return useMemo(() => ({ hidden, toggle, isolate }), [hidden, toggle, isolate])
}
