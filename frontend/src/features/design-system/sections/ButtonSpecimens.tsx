import { Copy, Pause, RefreshCw } from 'lucide-react'
import { Button, IconButton } from '@/ui/controls'
import type { ButtonProps, IconButtonProps } from '@/ui/controls'
import { noop } from '../sample/noop'
import { Specimen } from '../Specimen'

const VARIANTS = [
  { variant: 'primary', label: 'Apply' },
  { variant: 'secondary', label: 'Copy row' },
  { variant: 'ghost', label: 'Retry' },
] as const satisfies readonly { variant: ButtonProps['variant']; label: string }[]

/** Every button names its configuration, so the row needs no column headers. */
function ButtonRow({ variant, label }: (typeof VARIANTS)[number]) {
  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="type-data w-20 text-fg-muted">{variant}</span>
      <Button variant={variant} onClick={noop}>
        {label}
      </Button>
      <Button variant={variant} size="sm" onClick={noop}>
        {label}
      </Button>
      <Button variant={variant} disabled>
        disabled
      </Button>
      <Button variant={variant} aria-disabled="true">
        aria-disabled
      </Button>
    </li>
  )
}

const ICON_VARIANTS: readonly NonNullable<IconButtonProps['variant']>[] = [
  'primary',
  'secondary',
  'ghost',
]

function IconRow({ variant }: { variant: NonNullable<IconButtonProps['variant']> }) {
  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="type-data w-20 text-fg-muted">{variant}</span>
      <IconButton
        aria-label="Refresh now"
        shortcut="r"
        icon={RefreshCw}
        variant={variant}
        onClick={noop}
      />
      <IconButton
        aria-label="Pause updates"
        shortcut="p"
        icon={Pause}
        variant={variant}
        onClick={noop}
      />
      <IconButton aria-label="Copy row" shortcut="y" icon={Copy} variant={variant} disabled />
    </li>
  )
}

export function ButtonSpecimens() {
  return (
    <>
      <Specimen
        label="Button"
        note="28px (md) or 24px (sm), 44px on coarse pointers. disabled leaves the tab order; aria-disabled stays focusable so it can say why it is unavailable. Tab to see the focus ring."
      >
        <ul className="flex flex-col gap-3">
          {VARIANTS.map((row) => (
            <ButtonRow key={row.variant} {...row} />
          ))}
        </ul>
      </Specimen>
      <Specimen
        label="Icon button"
        note="Icon only: the label is its name and its tooltip, with the shortcut appended. Hover or focus one."
      >
        <ul className="flex flex-col gap-3">
          {ICON_VARIANTS.map((variant) => (
            <IconRow key={variant} variant={variant} />
          ))}
        </ul>
      </Specimen>
    </>
  )
}
