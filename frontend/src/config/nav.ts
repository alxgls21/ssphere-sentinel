import {
  BellRing,
  Building2,
  Container,
  LayoutDashboard,
  Network,
  Router,
  Server,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import type { FeatureId } from './features'

/**
 * Single source of truth for navigation. The sidebar, the command palette,
 * the "g <key>" go-to shortcuts and the router all read this list, so adding
 * a screen means adding one entry here.
 */
export interface NavItem {
  id: 'overview' | 'servers' | 'docker' | 'network' | 'snmp' | 'topology' | 'alerts' | 'customers'
  label: string
  path: string
  icon: LucideIcon
  /** Second key of the "g <key>" go-to chord. Unique. */
  chord: string
  /** One line for the command palette and screen headers. */
  description: string
  /** Backend feature this screen depends on, for readiness labelling. Overview spans several. */
  feature: FeatureId | null
  /** False until the screen has been designed and approved. */
  designed: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    path: '/',
    icon: LayoutDashboard,
    chord: 'o',
    description: 'Fleet health, alerts and recent events',
    feature: null,
    designed: true,
  },
  {
    id: 'servers',
    label: 'Servers',
    path: '/servers',
    icon: Server,
    chord: 's',
    description: 'Server inventory, CPU, memory, disk and uptime',
    feature: 'servers',
    designed: true,
  },
  {
    id: 'docker',
    label: 'Docker',
    path: '/docker',
    icon: Container,
    chord: 'd',
    description: 'Container inventory, state and health',
    feature: 'docker',
    designed: true,
  },
  {
    id: 'network',
    label: 'Network',
    path: '/network',
    icon: Network,
    chord: 'n',
    description: 'ICMP and TCP probes, latency and loss',
    feature: 'network',
    designed: true,
  },
  {
    id: 'snmp',
    label: 'SNMP',
    path: '/snmp',
    icon: Router,
    chord: 'p',
    description: 'Network devices, interfaces and bandwidth',
    feature: 'snmp',
    designed: true,
  },
  {
    id: 'topology',
    label: 'Topology',
    path: '/topology',
    icon: Waypoints,
    chord: 't',
    description: 'Network map and outage impact',
    feature: 'topology',
    designed: false,
  },
  {
    id: 'alerts',
    label: 'Alerts',
    path: '/alerts',
    icon: BellRing,
    chord: 'a',
    description: 'Warnings, criticals and the event timeline',
    feature: 'alerts',
    designed: false,
  },
  {
    id: 'customers',
    label: 'Customers & Sites',
    path: '/customers',
    icon: Building2,
    chord: 'c',
    description: 'Customers, sites and their devices',
    feature: 'customers',
    designed: false,
  },
]

export function navItemForPath(pathname: string): NavItem | undefined {
  if (pathname === '/') return NAV_ITEMS[0]
  return NAV_ITEMS.find(
    (item) => item.path !== '/' && (pathname === item.path || pathname.startsWith(`${item.path}/`)),
  )
}
