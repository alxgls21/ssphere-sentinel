import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { EMPTY } from '@/lib/format'
import { Specimen } from '../Specimen'

interface TypeSpec {
  /** The utility, written out in full so Tailwind's scanner sees it. */
  name: string
  /** Where the console uses it. */
  use: string
  /** Latin and Greek: the likely estate is Greek, and both faces ship that subset. */
  sample: string
}

const SCALE: readonly TypeSpec[] = [
  { name: 'type-hero', use: 'The verdict figure', sample: '121 Αθήνα' },
  { name: 'type-verdict', use: 'The verdict word', sample: 'Critical Κρίσιμο' },
  { name: 'type-kpi', use: 'Tile value', sample: '15/16 Πάτρα' },
  {
    name: 'type-title',
    use: 'Screen and dialog titles (prose)',
    sample: 'Nothing needs attention · Τίποτα δεν χρειάζεται προσοχή',
  },
  {
    name: 'type-body',
    use: 'Detail text, names, descriptions (prose)',
    sample: 'Connection refused after 3 attempts · Η σύνδεση απορρίφθηκε',
  },
  {
    name: 'type-body-strong',
    use: 'Emphasis in prose',
    sample: 'Not implemented · Δεν έχει υλοποιηθεί',
  },
  {
    name: 'type-prompt',
    use: 'Palette input, prompt line',
    sample: 'sentinel > athens-dc > Αθήνα',
  },
  {
    name: 'type-data',
    use: 'Table cells, hostnames, timestamps',
    sample: 'edge-gw-02 10.4.0.12 14:05:12Z Θεσσαλονίκη',
  },
  {
    name: 'type-data-strong',
    use: 'Entity names, buttons, selected values',
    sample: 'edge-gw-02 142 ms Θεσσαλονίκη',
  },
  {
    name: 'type-label',
    use: 'Panel titles, column headers',
    sample: 'Needs attention Χρειάζονται προσοχή',
  },
  {
    name: 'type-tag',
    use: 'Status words, chips, counts',
    sample: 'Crit Warn Planned Μη διαθέσιμο',
  },
  { name: 'type-kbd', use: 'Keycaps, panel index', sample: '[1] g o Ctrl K γ ο' },
  { name: 'type-chart', use: 'Chart axis ticks', sample: '13:40 13:45 150 ms Αθήνα' },
]

/** "JetBrains Mono · 12px/16px · 500 · 0.08em", read back from the element so the page reports what really applies. */
function describeType(style: CSSStyleDeclaration): string {
  const family = style.fontFamily.split(',')[0]?.replaceAll(/["']/g, '').trim()
  const size = Number.parseFloat(style.fontSize)
  const tracking = Number.parseFloat(style.letterSpacing)
  const spacing = Number.isFinite(tracking) && size > 0 ? `${(tracking / size).toFixed(2)}em` : '0'
  return [family, `${style.fontSize}/${style.lineHeight}`, style.fontWeight, spacing].join(' · ')
}

function TypeRow({ name, use, sample }: TypeSpec) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [resolved, setResolved] = useState<string | null>(null)
  useEffect(() => {
    if (ref.current) setResolved(describeType(getComputedStyle(ref.current)))
  }, [])

  return (
    <li className="grid gap-x-4 gap-y-1 border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col">
        <code className="type-data-strong">{name}</code>
        <span className="type-data text-fg-muted">{use}</span>
        <span className="type-data text-fg-faint">{resolved ?? EMPTY}</span>
      </div>
      <p ref={ref} className={cn(name, 'min-w-0 break-words')}>
        {sample}
      </p>
    </li>
  )
}

export function TypographySection() {
  return (
    <Specimen
      label="Scale"
      note="Mono carries everything a machine produced or that labels a machine value. Plex Sans is for prose a person wrote. Nothing renders below 11px."
    >
      <ul className="flex flex-col">
        {SCALE.map((type) => (
          <TypeRow key={type.name} {...type} />
        ))}
      </ul>
    </Specimen>
  )
}
