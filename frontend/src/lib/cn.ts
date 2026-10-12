/** Joins class names, skipping falsy values. Tailwind classes never conflict by design here. */
export function cn(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
