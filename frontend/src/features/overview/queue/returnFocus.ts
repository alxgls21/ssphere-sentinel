/**
 * Enter takes the operator to another screen and the Overview unmounts;
 * going back must land on the row they opened. The row travels in the history
 * entry's own state: it survives Back and Forward, belongs to that one visit,
 * and a fresh visit (the sidebar link) starts clean.
 */
const FIELD = 'attentionRow'

/** The row remembered by a history entry's state, if any. */
export function recallRow(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const value = (state as Record<string, unknown>)[FIELD]
  return typeof value === 'string' ? value : undefined
}

/** The entry's state with the opened row added; anything else stored there is kept. */
export function rememberRow(state: unknown, rowKey: string): Record<string, unknown> {
  const rest = typeof state === 'object' && state !== null ? state : {}
  return { ...rest, [FIELD]: rowKey }
}
