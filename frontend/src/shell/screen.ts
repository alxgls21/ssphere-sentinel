import { navItemForPath } from '@/config/nav'

/** Dev-only design-system gallery (see app/routes). */
export const DESIGN_SYSTEM_PATH = '/_ds'

/** The screen a path shows: breadcrumb, app bar and document title all read this. */
export function screenTitle(pathname: string): string {
  const item = navItemForPath(pathname)
  if (item) return item.label
  if (import.meta.env.DEV && pathname === DESIGN_SYSTEM_PATH) return 'Design system'
  return 'Not found'
}
