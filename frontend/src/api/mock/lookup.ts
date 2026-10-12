import type {
  Customer,
  DockerContainer,
  HealthStatus,
  NetworkTarget,
  Server,
  Site,
} from '@/api/types'
import { containerHealth, serverHealthWithResources, targetHealth } from '@/lib/status'
import type { Fleet } from './fixtures'

/**
 * Health of each entity. Always the shared classifiers from src/lib/status.ts,
 * never a local rule, so the console and a future HTTP adapter agree.
 */
export const serverHealthOf = (server: Server): HealthStatus =>
  serverHealthWithResources(server.status, server.telemetry)

export const containerHealthOf = (container: DockerContainer): HealthStatus =>
  containerHealth(container.state, container.health)

export const targetHealthOf = (target: NetworkTarget): HealthStatus => targetHealth(target)

export interface Place {
  siteId: string | null
  siteName?: string
  customerName?: string
}

export interface Lookup {
  serverById: Map<string, Server>
  siteById: Map<string, Site>
  customerById: Map<string, Customer>
  /** Names for the SITE column. Empty when the entity belongs to no site. */
  placeOfSite: (siteId: string | null) => Place
  /** A container lives where its server lives. */
  placeOfContainer: (container: DockerContainer) => Place
}

export function makeLookup(fleet: Fleet): Lookup {
  const serverById = new Map(fleet.servers.map((server) => [server.id, server]))
  const siteById = new Map(fleet.sites.map((site) => [site.id, site]))
  const customerById = new Map(fleet.customers.map((customer) => [customer.id, customer]))
  const placeOfSite = (siteId: string | null): Place => {
    const site = siteId === null ? undefined : siteById.get(siteId)
    if (!site) return { siteId }
    const customer = customerById.get(site.customerId)
    return {
      siteId,
      siteName: site.name,
      ...(customer ? { customerName: customer.name } : {}),
    }
  }
  return {
    serverById,
    siteById,
    customerById,
    placeOfSite,
    placeOfContainer: (container) =>
      placeOfSite(serverById.get(container.serverId)?.siteId ?? null),
  }
}
