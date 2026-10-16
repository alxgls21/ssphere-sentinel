/**
 * Where the arrow keys, Home and End take focus in a list of lines whose last
 * index is `last`: the line to move to, or null for any other key.
 */
export function lineTarget(key: string, from: number, last: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return Math.min(from + 1, last)
    case 'ArrowUp':
      return Math.max(from - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
