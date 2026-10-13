/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The layering rules of docs/architecture.md, checked mechanically. They used
 * to exist only on paper, and drifted: a rule that nothing enforces is a wish.
 * Only production code is scanned (tests and test kits may reach anywhere).
 */

const SRC = import.meta.dirname

interface Edge {
  from: string
  to: string
  file: string
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, found)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/^testing\./.test(entry))
      found.push(path)
  }
  return found
}

/** A path under src/ -> its layer: "features/overview", "api/mock", "ui", ... */
function layerOf(rel: string): string {
  const [top = '', second = ''] = rel.split('/')
  if (top === 'features') return second.includes('.') ? 'features' : `features/${second}`
  if (top === 'api' && second === 'mock') return 'api/mock'
  if (top === 'api' && second === 'http') return 'api/http'
  return top.includes('.') ? 'root' : top
}

const edges: Edge[] = []
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'((?:@\/|\.{1,2}\/)[^']*)'/g)) {
    const spec = match[1] as string
    const target = spec.startsWith('@/')
      ? spec.slice(2)
      : normalize(join(dirname(rel), spec))
          .split('\\')
          .join('/')
    const from = layerOf(rel)
    const to = layerOf(target)
    if (from !== to) edges.push({ from, to, file: rel })
  }
}

const importsOf = (layer: string) =>
  new Set(edges.filter((edge) => edge.from === layer).map((edge) => edge.to))
const offenders = (predicate: (edge: Edge) => boolean) =>
  edges.filter(predicate).map((edge) => `${edge.file} -> ${edge.to}`)

describe('the scanner itself', () => {
  it('sees the real import graph (a rule over an empty graph would pass for the wrong reason)', () => {
    expect(edges.length).toBeGreaterThan(300)
    expect(importsOf('ui')).toContain('lib')
    expect(importsOf('features/overview')).toContain('ui')
    expect(importsOf('app')).toContain('api/mock')
  })
})

describe('layering', () => {
  it('lib is pure: it depends on nothing but the domain types', () => {
    expect([...importsOf('lib')].filter((layer) => layer !== 'api')).toEqual([])
  })

  it('ui never reaches into shell, features or charts', () => {
    expect(
      offenders(
        (e) =>
          (e.from === 'ui' && ['shell', 'charts'].includes(e.to)) ||
          (e.from === 'ui' && e.to.startsWith('features')),
      ),
    ).toEqual([])
  })

  it('the shell and the charts never import a feature', () => {
    expect(
      offenders((e) => (e.from === 'shell' || e.from === 'charts') && e.to.startsWith('features')),
    ).toEqual([])
  })

  it('a feature never imports another feature (the design-system gallery shows every screen, so it may)', () => {
    expect(
      offenders(
        (e) =>
          e.from.startsWith('features/') &&
          e.to.startsWith('features/') &&
          e.from !== 'features/design-system',
      ),
    ).toEqual([])
  })

  it('only app/ knows the mock: screens, the shell and the primitives talk to the SentinelApi port', () => {
    expect(offenders((e) => e.to === 'api/mock' && e.from !== 'app')).toEqual([])
  })

  it('the mock depends on the contract and the shared rules, nothing more', () => {
    expect([...importsOf('api/mock')].filter((layer) => !['api', 'lib'].includes(layer))).toEqual(
      [],
    )
  })

  it('the HTTP adapter depends on the contract and nothing else, and only app/ wires it in', () => {
    expect([...importsOf('api/http')].filter((layer) => layer !== 'api')).toEqual([])
    expect(offenders((e) => e.to === 'api/http' && e.from !== 'app')).toEqual([])
  })

  it('the contract itself depends on nothing', () => {
    expect([...importsOf('api')]).toEqual([])
  })
})

describe('charts', () => {
  const files = sourceFiles(SRC).map((file) => ({
    rel: relative(SRC, file).split('\\').join('/'),
    text: readFileSync(file, 'utf8'),
  }))
  const outside = files.filter(({ rel }) => !rel.startsWith('charts/'))
  const names = (found: typeof files) => found.map(({ rel }) => rel)

  it('only charts/ touches the chart library: everything else reads it as types', () => {
    expect(names(outside.filter(({ text }) => /from\s+'echarts/.test(text)))).toEqual([])
    // A value import of the runtime module would drag the whole library into the importer's chunk.
    const valueImport = /^import\s+(?!type\b)(?:(?!from\s+')[\s\S])*from\s+'@\/charts\/echarts'/m
    expect(names(outside.filter(({ text }) => valueImport.test(text)))).toEqual([])
  })

  it('every chart is drawn by ChartFrame: its legend, crosshair, keyboard cursor and table twin come with it', () => {
    const callers = files.filter(({ text }) => /\buseECharts\(/.test(text))
    expect(names(callers).sort()).toEqual(['charts/ChartFrame.tsx', 'charts/useECharts.ts'])
  })
})
