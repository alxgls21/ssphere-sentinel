import { ApiError } from '../errors'

/**
 * Guards for answers from the network. The shape of an answer is never trusted:
 * anything that is not what the contract says is one error, `bad_response`.
 */

export const bad = () => new ApiError('The server sent an unexpected answer.', null, 'bad_response')

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw bad()
  return value
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw bad()
  return value
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw bad()
  return value
}

export const nullableText = (value: unknown): string | null => (value === null ? null : text(value))

export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad()
  return value
}

export const nullableNumber = (value: unknown): number | null =>
  value === null ? null : number(value)

/** Reads parallel arrays that must be as long as the time axis. */
export function parallel(t: readonly number[]) {
  return <T>(value: unknown, read: (sample: unknown) => T): T[] => {
    const values = array(value).map(read)
    if (values.length !== t.length) throw bad()
    return values
  }
}

/** A whole number from `min`. */
export function whole(value: unknown, min = 0): number {
  const n = number(value)
  if (!Number.isInteger(n) || n < min) throw bad()
  return n
}

export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw bad()
  return value
}

/** An ISO-8601 timestamp that parses. */
export function time(value: unknown): string {
  const iso = text(value)
  if (Number.isNaN(Date.parse(iso))) throw bad()
  return iso
}

export const nullableTime = (value: unknown): string | null => (value === null ? null : time(value))

/** One of `allowed`. */
export function oneOf<T extends string>(allowed: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw bad()
  return value as T
}
