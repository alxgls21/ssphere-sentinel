import { useState, type FocusEvent } from 'react'

/**
 * Keeps what is on screen still while it is being read. Hovering the element
 * these handlers go on, or focusing anything inside it, freezes `shown`; what
 * arrives meanwhile waits until the pointer and focus are gone, or `release`.
 * Until somebody reads, `shown` follows `latest`. A different `view` is the
 * operator's own doing, so it is shown at once, held or not.
 */
export function useReadHold<T>(latest: T, view: string) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused

  const [shown, setShown] = useState(latest)
  const [shownView, setShownView] = useState(view)
  if (view !== shownView) {
    setShownView(view)
    setShown(latest)
  } else if (!paused && shown !== latest) {
    setShown(latest)
  }

  return {
    shown,
    paused,
    /** Show `latest` now. */
    release: () => setShown(latest),
    handlers: {
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      },
    },
  }
}
