import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { walk } from './lib/walk.mjs'

const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')
const files = walk(root)
const read = (file) => readFileSync(path.join(root, file), 'utf8')

const playwrightConfigs = files.filter((file) =>
  /(^|\/)playwright[^/]*\.config\.[cm]?[jt]s$/.test(file),
)
const vitestConfigs = files.filter((file) => /(^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(file))

test('every Playwright config fails CI on a committed .only', () => {
  assert.ok(playwrightConfigs.includes('test/playwright.config.ts'))
  const unguarded = playwrightConfigs.filter((file) => {
    const text = read(file)
    const setsForbidOnly = /forbidOnly:\s*(?:!!process\.env\.CI|process\.env\.CI|CI)\s*,/.test(text)
    const inheritsBase = /\.\.\.baseConfig/.test(text) && /from '\.\/playwright\.config/.test(text)
    return !setsForbidOnly && !inheritsBase
  })
  assert.deepEqual(unguarded, [])
})

test('no vitest config re-enables .only (vitest allowOnly defaults to !isCI)', () => {
  const overriding = vitestConfigs.filter((file) => /allowOnly\s*:\s*(?!false\b)/.test(read(file)))
  assert.deepEqual(overriding, [])
})
