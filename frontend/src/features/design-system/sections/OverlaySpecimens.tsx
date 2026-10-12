import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Button, Kbd, Menu, ModKbd, Tooltip, type MenuItem } from '@/ui/controls'
import { noop } from '../sample/noop'
import { Specimen } from '../Specimen'

function Tooltips() {
  return (
    <Specimen
      label="Tooltip"
      note="Supplementary only: nothing is ever stated just in a tooltip. Opens after 300ms on hover and at once on keyboard focus; Escape dismisses."
    >
      <Tooltip content="Everything here is also in the visible label.">
        <Button onClick={noop}>Hover or focus me</Button>
      </Tooltip>
    </Specimen>
  )
}

function Menus() {
  const [shortcuts, setShortcuts] = useState(true)
  const [tz, setTz] = useState('utc')
  const items: readonly MenuItem[] = [
    { type: 'action', label: 'Refresh now', hint: 'r', onSelect: noop },
    { type: 'action', label: 'Copy link to this view', onSelect: noop },
    { type: 'separator' },
    { type: 'checkbox', label: 'Single-key shortcuts', checked: shortcuts, onChange: setShortcuts },
    {
      type: 'radio-group',
      label: 'Timezone',
      value: tz,
      options: [
        { value: 'utc', label: 'UTC' },
        { value: 'local', label: 'Local' },
      ],
      onChange: setTz,
    },
  ]
  return (
    <Specimen
      label="Menu"
      note="Focus moves to the first item and roves with the arrows, Home, End and typeahead. An action closes it; a checkbox or radio keeps it open."
    >
      <Menu
        label="Display"
        trigger={
          <>
            <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
            Display
          </>
        }
        items={items}
      />
    </Specimen>
  )
}

function Keycaps() {
  return (
    <Specimen label="Kbd" note="A keycap on the raised surface, for shortcuts and panel indexes.">
      <div className="flex flex-wrap items-center gap-3">
        <Kbd>r</Kbd>
        <span className="flex items-center gap-1">
          <Kbd>g</Kbd>
          <Kbd>o</Kbd>
        </span>
        <span className="flex items-center gap-1">
          <ModKbd />
          <Kbd>K</Kbd>
        </span>
        <Kbd>[1]</Kbd>
        <Kbd>Esc</Kbd>
      </div>
    </Specimen>
  )
}

export function OverlaySpecimens() {
  return (
    <>
      <Tooltips />
      <Menus />
      <Keycaps />
    </>
  )
}
