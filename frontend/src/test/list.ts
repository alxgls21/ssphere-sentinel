import type { HealthStatus, ServerList } from '@/api/types'
import { countStatuses, emptyCounts } from '@/lib/status'

type TestList<Item> = Omit<ServerList, 'items'> & { items: Item[] }

/** A list answer for target and device test fixtures. */
export function testList<Item extends { health: HealthStatus }>(
  items: Item[],
  nowMs: number,
  over: Partial<TestList<Item>> = {},
): TestList<Item> {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    items,
    page: { number: 1, size: 50, total: items.length, pages: 1 },
    counts: { ...emptyCounts(), ...countStatuses(items.map((entry) => entry.health)) },
    scopeTotal: items.length,
    ...over,
  }
}
