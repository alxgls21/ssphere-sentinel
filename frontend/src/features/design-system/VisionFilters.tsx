import { FILTERED_SIMULATIONS, colorMatrixValues, filterId } from './vision'

/**
 * The SVG filters the content wrapper points at with `filter: url(#id)`. The
 * element has no size but must stay rendered (display: none disables filters in
 * some engines), and it is hidden from assistive technology.
 */
export function VisionFilters() {
  return (
    <svg aria-hidden="true" focusable="false" className="pointer-events-none absolute size-0">
      <defs>
        {FILTERED_SIMULATIONS.map((simulation) => (
          <filter key={simulation} id={filterId(simulation)}>
            <feColorMatrix type="matrix" values={colorMatrixValues(simulation)} />
          </filter>
        ))}
      </defs>
    </svg>
  )
}
