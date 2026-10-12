/**
 * Window-level custom events that connect the global hotkey layer to panels
 * without either importing the other. Dispatch with `window.dispatchEvent(new CustomEvent(NAME, { detail }))`.
 */

/** Jump to the next / previous problem row in Needs attention. detail: { direction: 1 | -1 } */
export const NEXT_PROBLEM_EVENT = 'sentinel:next-problem'

export interface NextProblemDetail {
  direction: 1 | -1
}
