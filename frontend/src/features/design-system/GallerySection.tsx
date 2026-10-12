import type { ReactNode } from 'react'
import { sectionId } from './anchors'

interface GallerySectionProps {
  id: string
  /** 1-based position, shown as a quiet index before the title. */
  number: number
  title: string
  /** One sentence on what the section shows and how to read it. */
  intro: string
  children: ReactNode
}

/** A labelled section of the gallery: the page is a scrolling document, not a Panel. */
export function GallerySection({ id, number, title, intro, children }: GallerySectionProps) {
  const headingId = `${sectionId(id)}-title`
  return (
    // Clears the sticky toolbar when a jump link scrolls here.
    <section
      id={sectionId(id)}
      aria-labelledby={headingId}
      className="flex scroll-mt-28 flex-col gap-3"
    >
      <header className="flex flex-col gap-1 border-b border-border pb-2">
        <h2 id={headingId} className="type-title flex items-baseline gap-2">
          <span aria-hidden="true" className="type-kbd text-fg-faint">
            {String(number).padStart(2, '0')}
          </span>
          {title}
        </h2>
        <p className="type-body max-w-prose text-fg-muted">{intro}</p>
      </header>
      {children}
    </section>
  )
}
