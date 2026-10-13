/**
 * Color-vision simulation for design review. The palette's healthy, warning and
 * critical hues are only a few delta-E apart under protan and deutan vision, so
 * status is carried by shape and word and color merely agrees with them. These
 * filters let anyone check that claim on every component at once.
 */
export type Simulation = 'none' | 'grayscale' | 'protanopia' | 'deuteranopia' | 'tritanopia'

type Filtered = Exclude<Simulation, 'none'>

export interface SimulationOption {
  value: Simulation
  label: string
  /** What is being simulated, for the tooltip. */
  title: string
}

export const SIMULATIONS: readonly SimulationOption[] = [
  { value: 'none', label: 'None', title: 'No simulation' },
  {
    value: 'grayscale',
    label: 'Grayscale',
    title: 'Luminance only: a grayscale screenshot or print',
  },
  { value: 'protanopia', label: 'Protanopia', title: 'No long-wavelength (red) cones' },
  { value: 'deuteranopia', label: 'Deuteranopia', title: 'No medium-wavelength (green) cones' },
  { value: 'tritanopia', label: 'Tritanopia', title: 'No short-wavelength (blue) cones' },
]

/** Rec. 709 luminance weights: every output channel is the same gray. */
const LUMA = [0.2126, 0.7152, 0.0722] as const

/**
 * 3x3 matrices, row-major, on linear RGB. The three deficiencies are Machado,
 * Oliveira and Fernandes (2009) at severity 1.0 (complete absence of the cone).
 * SVG filter primitives work in linear RGB by default, which is the space the
 * paper defines them in, so they are applied as they are.
 */
const MATRICES: Record<Filtered, readonly number[]> = {
  grayscale: [...LUMA, ...LUMA, ...LUMA],
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
}

export const FILTERED_SIMULATIONS = Object.keys(MATRICES) as Filtered[]

export const filterId = (simulation: Filtered) => `ds-vision-${simulation}`

/**
 * The 20 values of an feColorMatrix (4 rows of R, G, B, A, offset): the 3x3
 * matrix for the color rows, alpha passed through untouched.
 */
export function colorMatrixValues(simulation: Filtered): string {
  const matrix = MATRICES[simulation]
  const colorRows = [0, 1, 2].map((row) => [...matrix.slice(row * 3, row * 3 + 3), 0, 0])
  return [...colorRows, [0, 0, 0, 1, 0]].flat().join(' ')
}

/** The CSS `filter` value for the content wrapper; undefined means no filter at all. */
export function visionFilter(simulation: Simulation): string | undefined {
  return simulation === 'none' ? undefined : `url(#${filterId(simulation)})`
}
