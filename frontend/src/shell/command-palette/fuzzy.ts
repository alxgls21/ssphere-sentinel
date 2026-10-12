const WORD_START_BONUS = 8
const RUN_BONUS = 5
const GAP_PENALTY = 1
/** Characters skipped before the first match cost at most this much, so long names are not punished. */
const LEAD_CAP = 3

/** The start of the text, or the first character after anything that is not a letter or digit. */
const startsWord = (text: string, index: number): boolean =>
  index === 0 || /[^a-z0-9]/.test(text.charAt(index - 1))

/**
 * Scores `query` as a subsequence of `text` (higher is better), or null when
 * its characters do not appear in order or only as a scattered, low-value
 * match. Characters that begin a word and characters that continue a run score
 * extra, so "gw" finds edge-gw-02 at the "gw" rather than at "edGe ... Wan".
 * Case and whitespace in the query are ignored.
 *
 * It is a small dynamic program rather than a greedy scan, because the first
 * subsequence found is often not the best one.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  const haystack = text.toLowerCase()
  if (wanted.length === 0) return 0
  if (wanted.length > haystack.length) return null

  // previous[j]: best score with the previous query character matched at text position j.
  let previous: number[] = []
  for (let i = 0; i < wanted.length; i++) {
    const current: number[] = new Array<number>(haystack.length).fill(-Infinity)
    // The best earlier match that is not adjacent, less the gap it leaves.
    let carry = -Infinity
    for (let j = 0; j < haystack.length; j++) {
      if (j >= 2) carry = Math.max(carry, previous[j - 2] ?? -Infinity) - GAP_PENALTY
      if (haystack[j] !== wanted[i]) continue
      const own = 1 + (startsWord(haystack, j) ? WORD_START_BONUS : 0)
      if (i === 0) current[j] = own - Math.min(j, LEAD_CAP)
      else current[j] = Math.max(carry, (previous[j - 1] ?? -Infinity) + RUN_BONUS) + own
    }
    previous = current
  }
  const best = Math.max(...previous)
  return best > 0 ? best : null
}

/**
 * Scores `query` only when it appears as one contiguous run in `text`, for the
 * long free-text fields (a detail line, a site, a customer). A scattered
 * subsequence is a feature for short names ("gw" finds edge-gw-02) but noise
 * for sentences: "pir" must not match every row whose detail happens to
 * contain a p, then an i, then an r.
 */
export function containsScore(query: string, text: string): number | null {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  if (wanted.length === 0) return 0
  const at = text.toLowerCase().indexOf(wanted)
  if (at < 0) return null
  // Same scale as a contiguous fuzzy match: first character plus a run bonus per extra one.
  return (
    1 +
    (startsWord(text.toLowerCase(), at) ? WORD_START_BONUS : 0) +
    (wanted.length - 1) * (RUN_BONUS + 1)
  )
}
