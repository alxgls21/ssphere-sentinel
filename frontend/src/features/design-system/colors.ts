/**
 * Color math for the palette review. Tokens are read from the running page, so
 * this file only parses and compares what the browser reports: it names no color.
 */

export type Rgba = readonly [red: number, green: number, blue: number, alpha: number]

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION = /^rgba?\(([^)]*)\)$/i

function fromHex(digits: string): Rgba {
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
  const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16)
  return [channel(0), channel(1), channel(2), full.length === 8 ? channel(3) / 255 : 1]
}

/** Browsers hand back a custom property as authored; jsdom normalizes the spacing. Both parse. */
function fromFunction(body: string): Rgba | null {
  const parts = body.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const [red, green, blue] = parts.slice(0, 3).map(Number)
  const last = parts[3]
  const alpha =
    last === undefined ? 1 : last.endsWith('%') ? Number.parseFloat(last) / 100 : Number(last)
  if (red === undefined || green === undefined || blue === undefined) return null
  return [red, green, blue, alpha].every(Number.isFinite) ? [red, green, blue, alpha] : null
}

/** Hex (3, 4, 6 or 8 digits) or an rgb function, as a browser reports a resolved token. Null when it is neither. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim()
  const hex = HEX.exec(text)
  if (hex?.[1]) return fromHex(hex[1])
  const fn = FUNCTION.exec(text)
  return fn?.[1] === undefined ? null : fromFunction(fn[1])
}

/** Uppercase six-digit hex, followed by " @ 72%" (say) for a translucent color. */
export function formatColor([red, green, blue, alpha]: Rgba): string {
  const hex = [red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  return alpha < 1 ? `#${hex} @ ${Math.round(alpha * 100)}%` : `#${hex}`
}

function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance. */
export function luminance([red, green, blue]: Rgba): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

/** WCAG contrast ratio, 1 to 21. Alpha is ignored: only opaque colors have a meaningful ratio. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [first, second] = [luminance(a), luminance(b)]
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`
}
