import { SegmentedControl } from '@/ui/controls'
import { SIMULATIONS, type Simulation } from './vision'

interface VisionToolbarProps {
  value: Simulation
  onChange: (value: Simulation) => void
}

/**
 * Sticky, so the simulation can be switched while reading any section. It sits
 * outside the filtered wrapper: the control must stay legible under every
 * simulation. Full-bleed over the content padding.
 */
export function VisionToolbar({ value, onChange }: VisionToolbarProps) {
  return (
    <div className="sticky top-0 z-10 -mx-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-bg px-3 py-2">
      <div className="flex max-w-full items-center gap-3">
        <span className="type-label shrink-0 text-fg-muted">Color vision</span>
        {/* Five labels are wider than a phone: the control scrolls inside this box, never the page. */}
        <div className="min-w-0 overflow-x-auto">
          <SegmentedControl
            aria-label="Color vision simulation"
            value={value}
            onChange={onChange}
            options={SIMULATIONS}
          />
        </div>
      </div>
      <p className="type-body min-w-0 flex-1 basis-80 text-fg-muted">
        Status must stay distinguishable by shape and word under every simulation. Color only
        reinforces it.
      </p>
    </div>
  )
}
