import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GHOST_VERSION } from './version'

describe('GHOST_VERSION', () => {
  it('matches package.json', () => {
    expect(GHOST_VERSION).toBe(JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).version)
  })
})
