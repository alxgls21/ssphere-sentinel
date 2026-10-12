import { SlidersHorizontal } from 'lucide-react'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { Menu } from '@/ui/controls'

/** Display preferences: single-key shortcuts, timezone, reduced motion. Stored locally by PrefsProvider. */
export function DisplayMenu() {
  const { tz, setTz, singleKeyShortcuts, setSingleKeyShortcuts, motion, setMotion } = usePrefs()
  const { openShortcuts } = useShell()
  return (
    <Menu
      label="Display options"
      trigger={<SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
      items={[
        { type: 'action', label: 'Keyboard shortcuts', hint: '?', onSelect: openShortcuts },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: 'Single-key shortcuts',
          checked: singleKeyShortcuts,
          onChange: setSingleKeyShortcuts,
        },
        {
          type: 'radio-group',
          label: 'Timezone',
          value: tz,
          options: [
            { value: 'utc', label: 'UTC' },
            { value: 'local', label: 'Local' },
          ],
          onChange: (value) => setTz(value === 'local' ? 'local' : 'utc'),
        },
        {
          type: 'checkbox',
          label: 'Reduce motion',
          checked: motion === 'reduce',
          onChange: (reduce) => setMotion(reduce ? 'reduce' : 'system'),
        },
      ]}
    />
  )
}
