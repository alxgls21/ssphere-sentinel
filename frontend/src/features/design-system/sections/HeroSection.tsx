import type { ReactNode } from 'react'
import type { OverviewSummary } from '@/api/types'
import {
  AlertsTile,
  ContainersTile,
  DevicesTile,
  ServersTile,
  TargetsTile,
  VerdictBar,
  VerdictHero,
} from '@/features/overview/hero'
import { SAMPLE_SUMMARIES } from '../sample/data'
import { SummaryScenario } from '../sample/SampleProviders'
import type { ScenarioKind } from '../sample/scenario'
import { Specimen } from '../Specimen'

interface VerdictSample {
  label: string
  kind: ScenarioKind
  summary: OverviewSummary
}

/** The five verdicts, then a critical one whose data is old because the latest refresh failed. */
const VERDICTS: readonly VerdictSample[] = [
  { label: 'Critical', kind: 'ready', summary: SAMPLE_SUMMARIES.critical },
  { label: 'Degraded', kind: 'ready', summary: SAMPLE_SUMMARIES.degraded },
  { label: 'Partial', kind: 'ready', summary: SAMPLE_SUMMARIES.partial },
  { label: 'Nominal', kind: 'ready', summary: SAMPLE_SUMMARIES.nominal },
  { label: 'No data', kind: 'no-data', summary: SAMPLE_SUMMARIES.critical },
  { label: 'Critical, stale', kind: 'refresh-failed', summary: SAMPLE_SUMMARIES.critical },
]

/** A labelled cell: the caption names the state the component is in. */
function Cell({
  label,
  className,
  children,
}: {
  label: string
  className: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="type-tag text-fg-muted">{label}</span>
      <div className={className}>{children}</div>
    </div>
  )
}

function Verdicts() {
  return (
    <Specimen
      label="Verdict hero"
      bare
      note="The glyph, the word and the figure carry the verdict; the tint and edge only agree. The block is 291 by 120px from xl up and a full-width 88px line below it. The compact bar is its phone form."
    >
      <div className="flex flex-wrap gap-x-3 gap-y-4">
        {VERDICTS.map(({ label, kind, summary }) => (
          <SummaryScenario key={label} kind={kind} summary={summary}>
            <div className="flex w-full min-w-0 flex-col gap-2 xl:w-[18.1875rem]">
              <Cell label={label} className="h-22 xl:h-30">
                <VerdictHero />
              </Cell>
              <VerdictBar />
            </div>
          </SummaryScenario>
        ))}
      </div>
    </Specimen>
  )
}

/** Tiles are 171 by 120px at the reference width and fill their cell; the box gives them the height. */
const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(10.75rem,1fr))] gap-x-3 gap-y-4'
const TILE_BOX = 'h-30'

const TileBox = ({ children }: { children: ReactNode }) => (
  <div className={TILE_BOX}>{children}</div>
)

function Tiles() {
  return (
    <Specimen
      label="Stat tiles"
      bare
      note="One link per implemented domain. Net targets is the only tile with a trend, because the backend stores probe history. Devices and Alerts are planned: dashed frame, PLANNED chip, no link."
    >
      <SummaryScenario summary={SAMPLE_SUMMARIES.critical}>
        <div className={TILE_GRID}>
          <TileBox>
            <ServersTile />
          </TileBox>
          <TileBox>
            <ContainersTile />
          </TileBox>
          <TileBox>
            <TargetsTile />
          </TileBox>
          <TileBox>
            <DevicesTile />
          </TileBox>
          <TileBox>
            <AlertsTile />
          </TileBox>
        </div>
      </SummaryScenario>
    </Specimen>
  )
}

const TILE_STATES: readonly { label: string; kind: ScenarioKind }[] = [
  { label: 'Loading', kind: 'loading' },
  { label: 'Error', kind: 'error' },
  { label: 'Stale (refresh failed)', kind: 'refresh-failed' },
]

function TileStates() {
  return (
    <Specimen
      label="Tile states"
      bare
      note="Loading shows a skeleton after 150ms. A failed first load offers Retry. A failed refresh keeps the numbers, dims them and says stale in the tile's name."
    >
      <div className={TILE_GRID}>
        {TILE_STATES.map(({ label, kind }) => (
          <SummaryScenario key={kind} kind={kind} summary={SAMPLE_SUMMARIES.critical}>
            <Cell label={label} className={TILE_BOX}>
              <ServersTile />
            </Cell>
          </SummaryScenario>
        ))}
      </div>
    </Specimen>
  )
}

export function HeroSection() {
  return (
    <div className="flex flex-col gap-4">
      <Verdicts />
      <Tiles />
      <TileStates />
    </div>
  )
}
