import { ListFilter } from 'lucide-react'
import { useRange } from '@/app/viewState'
import { DEFAULT_RANGE, RANGE_OPTIONS, isRangeKey } from '@/lib/range'
import { Menu, type MenuItem } from '@/ui/controls'
import { ALL, type ScopeState } from './scope'

const RANGE_CHOICES = RANGE_OPTIONS.map((value) => ({ value, label: value }))

/**
 * Below 1280px the scope pickers and the time range fold into one menu. Its
 * trigger shows how many filters are active, because the breadcrumb no longer
 * carries the scope there.
 */
export function FiltersMenu({
  state,
  iconOnly = false,
}: {
  state: ScopeState
  iconOnly?: boolean
}) {
  const { scope, choices, setCustomer, setSite } = state
  const [range, setRange] = useRange()
  const active =
    (scope.customerId ? 1 : 0) + (scope.siteId ? 1 : 0) + (range === DEFAULT_RANGE ? 0 : 1)

  const items: MenuItem[] = [
    {
      type: 'radio-group',
      label: 'Customer',
      value: scope.customerId ?? ALL,
      options: choices.customers,
      onChange: setCustomer,
    },
    {
      type: 'radio-group',
      label: 'Site',
      value: scope.siteId ?? ALL,
      options: choices.sites,
      onChange: setSite,
    },
    {
      type: 'radio-group',
      label: 'Time range (range panels only)',
      value: range,
      options: RANGE_CHOICES,
      onChange: (value) => {
        if (isRangeKey(value)) setRange(value)
      },
    },
  ]

  return (
    <Menu
      label={active ? `Filters, ${active} active` : 'Filters'}
      items={items}
      trigger={
        <>
          <ListFilter size={16} strokeWidth={1.5} aria-hidden="true" />
          {iconOnly ? null : <span>Filters</span>}
          {active ? <span className="tnum text-primary">{active}</span> : null}
        </>
      }
    />
  )
}
