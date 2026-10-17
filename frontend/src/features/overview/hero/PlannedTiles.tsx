import { StatTile } from './StatTile'
import { navPath } from './tileText'
import type { FeatureId } from '@/config/features'
import type { NavItem } from '@/config/nav'

interface TileProps {
  /** Grid placement from the strip. */
  className?: string
}

/**
 * A domain the console API does not serve: its tile has a label, a dashed frame and one line
 * saying why, and shows no figure, not even a zero. It feeds nothing, the verdict included.
 */
function UnavailableTile({
  label,
  features,
  route,
  className,
}: TileProps & { label: string; features: FeatureId; route: NavItem['id'] }) {
  return (
    <StatTile
      label={label}
      features={features}
      to={navPath(route)}
      status="success"
      className={className}
    />
  )
}

export const TargetsTile = ({ className }: TileProps) => (
  <UnavailableTile label="Net targets" features="network" route="network" className={className} />
)

export const DevicesTile = ({ className }: TileProps) => (
  <UnavailableTile label="Devices" features="snmp" route="snmp" className={className} />
)

export const AlertsTile = ({ className }: TileProps) => (
  <UnavailableTile label="Alerts" features="alerts" route="alerts" className={className} />
)
