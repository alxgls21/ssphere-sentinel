import { MockChip, PlannedChip, SourceTag } from '@/ui/provenance/Chips'
import { Specimen } from '../Specimen'

/**
 * Provenance is data, not decoration: neutral hatch for mock, a dashed frame
 * and dotted ring for planned. Neither adds a hue, so both survive a screenshot
 * and every color-vision simulation.
 */
export function ProvenanceSection() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Specimen
        label="Mock chip"
        note="Global, in the topbar, while the data source is mock. A 135 degree hatch of two neutral surfaces."
      >
        <MockChip />
      </Specimen>
      <Specimen
        label="Planned chip"
        note="A feature the backend has not implemented: dashed outline and the dotted ring. Never feeds the verdict."
      >
        <PlannedChip />
      </Specimen>
      <Specimen
        label="Source tag"
        note="Quiet tag in every panel header: the data source, then the refresh interval."
      >
        <div className="flex flex-col items-start gap-2">
          <SourceTag source="mock" refreshMs={15_000} />
          <SourceTag source="mock" />
          <SourceTag source="live" refreshMs={15_000} />
          <SourceTag source="live" />
        </div>
      </Specimen>
    </div>
  )
}
