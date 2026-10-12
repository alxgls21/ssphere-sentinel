/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { APP_VERSION } from './version'

it('matches the version in package.json, which the status bar shows', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
  expect(APP_VERSION).toBe(manifest.version)
})
