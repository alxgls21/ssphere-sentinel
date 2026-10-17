import { cn } from '@/lib/cn'

/**
 * The logomark (a prompt chevron and a cursor block, as in the favicon) and the SENTINEL wordmark.
 * `nameYieldsOnPhones` keeps the name for assistive technology and draws only the mark below 24rem
 * (a 360px phone), where an app bar has no room for both the name and its controls.
 */
export function Wordmark({ nameYieldsOnPhones = false }: { nameYieldsOnPhones?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <svg
        viewBox="0 0 32 32"
        className="size-5 shrink-0 text-primary"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M9 10l7 6-7 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="square"
        />
        <rect x="18" y="20" width="7" height="3" fill="currentColor" />
      </svg>
      <span className={cn('type-label text-fg', nameYieldsOnPhones && 'max-[24rem]:sr-only')}>
        SENTINEL
      </span>
    </span>
  )
}
