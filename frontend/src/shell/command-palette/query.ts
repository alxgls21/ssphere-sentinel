/**
 * What the palette searches. Four of these have a scope chip (All, Go to,
 * Entities, Actions); "sites" (#) and "help" (?) exist only as prefixes.
 */
export type Scope = 'all' | 'goto' | 'entities' | 'actions' | 'sites' | 'help'

export type ScopeChip = 'all' | 'goto' | 'entities' | 'actions'

export const SCOPE_CHIPS: readonly { id: ScopeChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'goto', label: 'Go to' },
  { id: 'entities', label: 'Entities' },
  { id: 'actions', label: 'Actions' },
]

/** A first character that narrows the search, so ">" runs commands and "@" jumps to an entity. */
const PREFIX_SCOPES = new Map<string, Scope>([
  ['>', 'actions'],
  ['@', 'entities'],
  ['#', 'sites'],
  ['?', 'help'],
])

export interface ParsedQuery {
  scope: Scope
  /** What is left to match once the prefix is taken off. */
  text: string
}

/** A prefix typed in the input wins over the chip, so the two never disagree about the scope. */
export function parseQuery(raw: string, chip: ScopeChip): ParsedQuery {
  const typed = raw.trimStart()
  const scope = PREFIX_SCOPES.get(typed.charAt(0))
  return scope ? { scope, text: typed.slice(1).trim() } : { scope: chip, text: typed.trim() }
}

export function stripPrefix(raw: string): string {
  const typed = raw.trimStart()
  return PREFIX_SCOPES.has(typed.charAt(0)) ? typed.slice(1) : raw
}

/** The chip that reads as pressed for a scope; sites sit under Entities and help has no chip. */
export function chipOf(scope: Scope): ScopeChip | null {
  switch (scope) {
    case 'sites':
      return 'entities'
    case 'help':
      return null
    default:
      return scope
  }
}

/** The next or previous chip, wrapping (Tab and Shift+Tab). Help, which has no chip, steps to All. */
export function stepChip(current: ScopeChip | null, direction: 1 | -1): ScopeChip {
  const from = SCOPE_CHIPS.findIndex((chip) => chip.id === current)
  if (from === -1) return 'all'
  const next = SCOPE_CHIPS[(from + direction + SCOPE_CHIPS.length) % SCOPE_CHIPS.length]
  return next?.id ?? 'all'
}
