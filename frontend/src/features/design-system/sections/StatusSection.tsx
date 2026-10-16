import type { DisplayStatus } from '@/lib/status'
import { StatusGlyph, StatusLegend, StatusTag, type GlyphShape, type GlyphSize } from '@/ui/status'
import { Specimen } from '../Specimen'

const SHAPES: readonly GlyphShape[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
  'planned',
]

const SIZES: readonly GlyphSize[] = [6, 10, 12, 16, 24]

const SHOWN: readonly DisplayStatus[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
]

/** The class word (OK, WARN, ...) is the default; a domain word replaces it where one is more specific. */
const DOMAIN_WORDS: Record<DisplayStatus, readonly string[]> = {
  healthy: ['ONLINE', 'RUNNING', 'HEALTHY', 'UP'],
  warning: ['DEGRADED', 'RESTARTING'],
  critical: ['UNHEALTHY', 'DEAD', 'DOWN'],
  offline: ['OFFLINE'],
  unknown: [],
  idle: [],
}

const VARIANTS = ['plain', 'tag'] as const

function Glyphs() {
  return (
    <Specimen
      label="Glyphs"
      note="Shape is the first channel: circle, triangle, diamond, hollow square, ring, bar. From 10px each carries a cue inside (check, exclamation, cross, slash). Offline is critical shown apart: a server whose agent stopped reporting. The dotted ring marks provenance (planned), never a health state. The 6px dot is the quiet OK of dense strips."
    >
      <table className="w-full">
        <caption className="sr-only">Every status glyph at every size</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="type-label px-2 py-2 text-left font-medium text-fg-faint">
              Status
            </th>
            {SIZES.map((size) => (
              <th
                key={size}
                scope="col"
                className="type-label px-2 py-2 text-left font-medium text-fg-faint"
              >
                {size}px
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHAPES.map((status) => (
            <tr key={status} className="border-b border-border last:border-b-0">
              <th scope="row" className="type-data px-2 py-2 text-left font-normal text-fg-muted">
                {status}
              </th>
              {SIZES.map((size) => (
                <td key={size} className="px-2 py-2">
                  <StatusGlyph status={status} size={size} label={`${status}, ${size}px`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Specimen>
  )
}

function Tags() {
  return (
    <Specimen
      label="Tags"
      note="Shape, word and color together, never color alone. Plain is glyph and word for dense lists. Tag puts the word on the status tint, at least 6 characters wide so a column of tags is one scan line."
    >
      <ul className="flex flex-col">
        {SHOWN.map((status) => {
          // undefined is the class word; the rest are domain words.
          const words = [undefined, ...DOMAIN_WORDS[status]]
          return (
            <li
              key={status}
              className="grid gap-x-3 gap-y-2 border-b border-border py-2 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[5.5rem_minmax(0,1fr)]"
            >
              <span className="type-data text-fg-muted">{status}</span>
              <div className="flex flex-col gap-2">
                {VARIANTS.map((variant) => (
                  <div key={variant} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="type-tag w-10 text-fg-faint">{variant}</span>
                    {words.map((word) => (
                      <StatusTag
                        key={word ?? 'class'}
                        status={status}
                        word={word}
                        variant={variant}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </Specimen>
  )
}

function Legend() {
  return (
    <Specimen
      label="Legend"
      note="Every state beside its word, in the order of the alphabet. The Overview closes its health panel with it, listing OK, WARN and CRIT always and the other states only when a mark in the panel uses them."
    >
      <StatusLegend />
    </Specimen>
  )
}

export function StatusSection() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Glyphs />
      <Tags />
      <Legend />
    </div>
  )
}
