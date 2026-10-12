import { useLayoutEffect, type RefObject } from 'react'

/** Distance kept between an overlay and the viewport edge, and between a menu and its trigger. */
const EDGE = 8
const TOOLTIP_GAP = 6
const MENU_GAP = 4

export interface Size {
  width: number
  height: number
}

export interface Anchor extends Size {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Spot {
  left: number
  top: number
  /** Menus cap their height to the room left below the trigger. */
  maxHeight?: number
}

export type Placer = (anchor: Anchor, overlay: Size, viewport: Size) => Spot

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

/**
 * Centered above the trigger; flipped below when the room above is too small
 * and there is more below. Clamped horizontally so it never leaves the viewport.
 */
export const placeTooltip: Placer = (anchor, overlay, viewport) => {
  const above = anchor.top - TOOLTIP_GAP - overlay.height
  const flip = above < EDGE && viewport.height - anchor.bottom > anchor.top
  const centered = anchor.left + (anchor.width - overlay.width) / 2
  return {
    left: clamp(centered, EDGE, Math.max(EDGE, viewport.width - overlay.width - EDGE)),
    top: flip ? anchor.bottom + TOOLTIP_GAP : Math.max(EDGE, above),
  }
}

/** Below the trigger with the right edges aligned (the Display menu sits at the far right). */
export const placeMenu: Placer = (anchor, overlay, viewport) => {
  const top = anchor.bottom + MENU_GAP
  return {
    left: clamp(
      anchor.right - overlay.width,
      EDGE,
      Math.max(EDGE, viewport.width - overlay.width - EDGE),
    ),
    top,
    maxHeight: Math.max(0, viewport.height - top - EDGE),
  }
}

/**
 * Overlays are portaled, and a modal <dialog> sits in the top layer above
 * everything else in the document, so an overlay opened from inside one must
 * live inside it or it would be hidden behind the dialog (and inert).
 */
export function overlayHost(anchor: Element): HTMLElement {
  return anchor.closest('dialog') ?? document.body
}

/**
 * Positions a `position: fixed` overlay next to its anchor before paint, and
 * keeps it there on scroll and resize. Styles are written straight to the
 * element: the overlay never needs a second render to settle.
 */
export function useFixedPlacement(
  ref: RefObject<HTMLElement | null>,
  anchor: HTMLElement | null,
  place: Placer,
) {
  useLayoutEffect(() => {
    const overlay = ref.current
    if (!overlay || !anchor) return
    const update = () => {
      // clientWidth excludes the scrollbar; jsdom reports 0 for it.
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      }
      const { width, height } = overlay.getBoundingClientRect()
      const spot = place(anchor.getBoundingClientRect(), { width, height }, viewport)
      overlay.style.left = `${spot.left}px`
      overlay.style.top = `${spot.top}px`
      if (spot.maxHeight !== undefined) overlay.style.maxHeight = `${spot.maxHeight}px`
    }
    update()
    // Content that changes while the overlay is open (a live tooltip) changes its size.
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(overlay)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [ref, anchor, place])
}
