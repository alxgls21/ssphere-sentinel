import { useState, type ComponentType } from 'react'
import { GalleryProviders } from './sample/SampleProviders'
import { GallerySection } from './GallerySection'
import { VisionFilters } from './VisionFilters'
import { VisionToolbar } from './VisionToolbar'
import { sectionId } from './anchors'
import { ChartsSection } from './sections/ChartsSection'
import { ControlsSection } from './sections/ControlsSection'
import { HeroSection } from './sections/HeroSection'
import { MetersSection } from './sections/MetersSection'
import { MotionSection } from './sections/MotionSection'
import { PaletteSection } from './sections/PaletteSection'
import { PanelStatesSection } from './sections/PanelStatesSection'
import { ProvenanceSection } from './sections/ProvenanceSection'
import { StatusSection } from './sections/StatusSection'
import { TimelineSection } from './sections/TimelineSection'
import { TypographySection } from './sections/TypographySection'
import { visionFilter, type Simulation } from './vision'

interface SectionDef {
  id: string
  title: string
  intro: string
  Body: ComponentType
}

/** The one list the jump links and the sections are both built from, so they cannot drift apart. */
const SECTIONS: readonly SectionDef[] = [
  {
    id: 'palette',
    title: 'Palette',
    intro:
      'Every color token, resolved from the running page. Contrast is measured against the panel, the surface the system is designed on.',
    Body: PaletteSection,
  },
  {
    id: 'typography',
    title: 'Typography',
    intro:
      'The type scale, with Latin and Greek samples. Each row reports the family, size, weight and tracking the page actually applies.',
    Body: TypographySection,
  },
  {
    id: 'status',
    title: 'Status alphabet',
    intro:
      'Health is a shape, a word and a color together. Switch the color-vision simulation above and the shapes and words must still tell the states apart.',
    Body: StatusSection,
  },
  {
    id: 'provenance',
    title: 'Provenance',
    intro: 'Everything is mock data and says so. Features the backend lacks are marked planned.',
    Body: ProvenanceSection,
  },
  {
    id: 'controls',
    title: 'Controls',
    intro: 'The small in-house kit: one focus, size and token contract for every control.',
    Body: ControlsSection,
  },
  {
    id: 'meters',
    title: 'Meters',
    intro:
      'Plain SVG and DOM marks: composition by state, utilisation, a trend, and one glyph per entity.',
    Body: MetersSection,
  },
  {
    id: 'panel-states',
    title: 'Panel states',
    intro:
      'One panel in every state. Loading, empty, error and stale replace the body only; the header and frame never move.',
    Body: PanelStatesSection,
  },
  {
    id: 'hero',
    title: 'Hero',
    intro:
      'The verdict in each of its states, and the stat tiles, built from static sample summaries.',
    Body: HeroSection,
  },
  {
    id: 'charts',
    title: 'Charts',
    intro: 'The chart frame with its legend and table twin, on a static sample series.',
    Body: ChartsSection,
  },
  {
    id: 'timeline',
    title: 'Timeline',
    intro:
      'The incidents among the events of a range, one lane each on a shared time axis: what failed, what recovered, and what is still open.',
    Body: TimelineSection,
  },
  {
    id: 'motion',
    title: 'Motion',
    intro: 'Motion only explains change. Replay each animation the console uses.',
    Body: MotionSection,
  },
]

/**
 * Dev-only gallery (route /_ds): every shared component in every state, on
 * static sample data, so the design system can be reviewed in the browser.
 * The simulation switch applies a color-vision filter to all of it, which is
 * how the shape-plus-word rule for status is checked rather than assumed.
 * Needs the app's router and preferences above it, like any screen.
 */
export default function DesignSystemPage() {
  const [simulation, setSimulation] = useState<Simulation>('none')

  return (
    <GalleryProviders>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="type-title">Design system</h1>
          <p className="type-body max-w-prose text-fg-muted">
            Every shared component in every state. This route exists only in development, and every
            value on it is sample data. The color-vision control applies Machado 2009 filters
            (severity 1.0) or a luminance grayscale to everything below it; menus and tooltips open
            outside that area and are not simulated.
          </p>
          <nav aria-label="Sections">
            <ol className="type-data flex flex-wrap gap-x-4">
              {SECTIONS.map(({ id, title }) => (
                <li key={id}>
                  <a
                    href={`#${sectionId(id)}`}
                    className="inline-flex min-h-(--hit) items-center text-primary underline underline-offset-2 hover:text-primary-hover"
                  >
                    {title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </header>

        <VisionToolbar value={simulation} onChange={setSimulation} />
        <VisionFilters />

        {/* The filter goes on this wrapper and not the page: the toolbar must stay legible under every simulation. */}
        <div
          data-simulation={simulation}
          style={{ filter: visionFilter(simulation) }}
          className="flex flex-col gap-10"
        >
          {SECTIONS.map(({ id, title, intro, Body }, index) => (
            <GallerySection key={id} id={id} number={index + 1} title={title} intro={intro}>
              <Body />
            </GallerySection>
          ))}
        </div>
      </div>
    </GalleryProviders>
  )
}
