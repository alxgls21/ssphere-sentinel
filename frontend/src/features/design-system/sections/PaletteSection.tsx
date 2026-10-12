import { useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { StatusTag } from '@/ui/status'
import { formatColor, formatRatio } from '../colors'
import { Specimen } from '../Specimen'
import { REQUIREMENT, resolvePalette, type ResolvedToken } from '../tokens'

function Swatch({ token }: { token: ResolvedToken }) {
  const { color, ratio } = token
  return (
    <div className="flex min-w-0 gap-3">
      <span
        aria-hidden="true"
        style={{ backgroundColor: `var(${token.cssName})` }}
        className="size-10 shrink-0 rounded-sm border border-border-strong"
      />
      <div className="flex min-w-0 flex-col">
        <code className="type-data-strong truncate">{token.cssName}</code>
        <span className="type-data tnum text-fg-muted">
          {color ? formatColor(color) : token.raw || 'unresolved'}
        </span>
        <span className="type-data text-fg-faint">{token.role}</span>
        {token.use === 'text' ? (
          // The token as ink on the panel: the one place a swatch is not enough to judge it.
          <span style={{ color: `var(${token.cssName})` }} className="type-data-strong">
            Aa 0123 Αθήνα
          </span>
        ) : null}
        <span className="type-data tnum flex flex-wrap items-center gap-x-2 text-fg-faint">
          {ratio !== null ? `${formatRatio(ratio)} on panel` : null}
          <span>{REQUIREMENT[token.use]}</span>
          {/* Passing is the norm and says nothing; missing the bar is a failure and reads as one. */}
          {token.passes === false ? <StatusTag status="critical" word="FAIL" /> : null}
        </span>
      </div>
    </div>
  )
}

/** Reads every token once, when it mounts; a new key re-reads them. */
function TokenGroups() {
  const [groups] = useState(() => resolvePalette(getComputedStyle(document.documentElement)))
  return (
    <>
      {groups.map((group) => (
        <Specimen key={group.id} label={group.label}>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-3 gap-y-4">
            {group.tokens.map((token) => (
              <li key={token.name} className="min-w-0">
                <Swatch token={token} />
              </li>
            ))}
          </ul>
        </Specimen>
      ))}
    </>
  )
}

export function PaletteSection() {
  const highContrast = useMediaQuery('(prefers-contrast: more)')
  // The contrast preference rewrites tokens (muted and faint text become primary ink): read them again.
  return <TokenGroups key={highContrast ? 'more' : 'standard'} />
}
