import { useMediaQuery } from '@/hooks/useMediaQuery'

/**
 * The shell's responsive modes. They are "below" queries on purpose: where a
 * query is unanswered (tests, anything without matchMedia) it reads false and
 * the full desktop layout renders, which is the layout everything else is
 * written against.
 */
export interface LayoutMode {
  /** Below 768px: a 48px app bar replaces the topbar and the status bar is hidden. */
  phone: boolean
  /** Below 1024px: the sidebar is an off-canvas drawer behind a menu button. */
  drawer: boolean
  /** Below 1280px: the breadcrumb shortens to the screen title and scope and time fold into Filters. */
  compact: boolean
}

export function useLayoutMode(): LayoutMode {
  return {
    phone: useMediaQuery('(width < 48rem)'),
    drawer: useMediaQuery('(width < 64rem)'),
    compact: useMediaQuery('(width < 80rem)'),
  }
}
