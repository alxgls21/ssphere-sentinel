import { Select } from '@/ui/controls'
import { ALL, type ScopeState } from './scope'

/** Customer, then site: two native selects. The scope lives in the URL and scopes every panel. */
export function ScopePicker({ state }: { state: ScopeState }) {
  const { scope, choices, ready, setCustomer, setSite } = state
  return (
    <>
      <Select
        label="Customer"
        hideLabel
        value={scope.customerId ?? ALL}
        onChange={setCustomer}
        options={choices.customers}
        disabled={!ready}
        className="w-36 min-w-24"
      />
      <Select
        label="Site"
        hideLabel
        value={scope.siteId ?? ALL}
        onChange={setSite}
        options={choices.sites}
        disabled={!ready}
        className="w-32 min-w-24"
      />
    </>
  )
}
