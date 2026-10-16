import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { analyze, buildRules, checkRuleSources } from './test-reachability.mjs'
import { walk } from './lib/walk.mjs'

const realRoot = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')

let tree
beforeEach(() => {
  tree = mkdtempSync(path.join(tmpdir(), 'reachability-'))
})
afterEach(() => {
  rmSync(tree, { force: true, recursive: true })
})

function write(...files) {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
    writeFileSync(path.join(tree, file), '')
  }
}

const rulesFor = (overrides = {}) =>
  buildRules({
    matrixSuites: ['foo', 'admin__e2e__general', 'lexical__collections__Blocks#config.blockreferences.ts'],
    templates: ['blank'],
    tstycheGlobs: ['test/**/types.spec.ts'],
    visualSuites: ['admin__e2e__visual'],
    ...overrides,
  })

const run = (exclusions = [], rules = rulesFor()) =>
  analyze({ exclusions, files: walk(tree), rules })

describe('reachability of spec files', () => {
  test('a spec file that a job runs passes', () => {
    write(
      'packages/payload/src/a.spec.ts',
      'packages/ui/src/b.spec.tsx',
      'test/foo/e2e.spec.ts',
      'test/foo/int.spec.ts',
      'test/types/types.spec.ts',
      'test/admin/e2e/general/e2e.spec.ts',
      'test/admin/e2e/visual/e2e.spec.ts',
      'templates/blank/tests/int/api.int.spec.ts',
      '.github/scripts/gate.test.mjs',
    )
    const { problems, uncovered } = run()
    assert.deepEqual(problems, [])
    assert.deepEqual(uncovered, [])
  })

  test('an uncovered spec file that is not listed fails and names the file', () => {
    write('test/orphan/e2e.spec.ts', 'test/foo/e2e.spec.ts')
    const { problems, unlisted } = run()
    assert.deepEqual(unlisted, ['test/orphan/e2e.spec.ts'])
    assert.deepEqual(problems, [
      'not run by any job and not in the exclusion list: test/orphan/e2e.spec.ts',
    ])
  })

  test('an uncovered spec file listed with a reason passes', () => {
    write('test/orphan/e2e.spec.ts')
    const exclusions = [{ path: 'test/orphan/e2e.spec.ts', reason: 'not run upstream' }]
    assert.deepEqual(run(exclusions).problems, [])
  })

  test('a listed file that a job now runs must be removed from the list', () => {
    write('test/foo/e2e.spec.ts')
    const { problems } = run([{ path: 'test/foo/e2e.spec.ts', reason: 'was orphaned' }])
    assert.match(problems.join('\n'), /now run by tests-e2e, remove the entry/)
  })

  test('a listed file that no longer exists must be removed from the list', () => {
    const { problems } = run([{ path: 'test/gone/e2e.spec.ts', reason: 'was orphaned' }])
    assert.match(problems.join('\n'), /no longer exists as a spec file/)
  })

  test('an exclusion needs a reason and may be listed once', () => {
    write('test/orphan/e2e.spec.ts')
    const { problems } = run([
      { path: 'test/orphan/e2e.spec.ts', reason: ' ' },
      { path: 'test/orphan/e2e.spec.ts', reason: 'twice' },
      { path: 'test/orphan/e2e.spec.ts', reason: 'thrice' },
    ])
    assert.match(problems.join('\n'), /exclusion without a reason/)
    assert.match(problems.join('\n'), /listed twice/)
  })
})

describe('how each job selects its files', () => {
  test('E2E runs only <suite folder>/*e2e.spec.ts, not nested folders or perf specs', () => {
    write('test/foo/sub/e2e.spec.ts', 'test/foo/perf.spec.ts', 'test/foo/other.e2e.spec.ts')
    const { coveredBy, uncovered } = run()
    assert.deepEqual([...coveredBy.keys()], ['test/foo/other.e2e.spec.ts'])
    assert.deepEqual(uncovered, ['test/foo/perf.spec.ts', 'test/foo/sub/e2e.spec.ts'])
  })

  test('E2E suite names map `__` to folders and drop the #config suffix', () => {
    write(
      'test/admin/e2e/general/e2e.spec.ts',
      'test/lexical/collections/Blocks/e2e.spec.ts',
      'test/admin/e2e/other/e2e.spec.ts',
    )
    assert.deepEqual(run().uncovered, ['test/admin/e2e/other/e2e.spec.ts'])
  })

  test('rsc specs run only under packages/next; elsewhere they are excluded from unit', () => {
    write('packages/next/src/a.rsc.spec.ts', 'packages/payload/src/b.rsc.spec.ts')
    assert.deepEqual(run().uncovered, ['packages/payload/src/b.rsc.spec.ts'])
  })

  test('component specs are .spec.tsx under packages only', () => {
    write('packages/ui/src/a.spec.tsx', 'test/x/b.spec.tsx')
    assert.deepEqual(run().uncovered, ['test/x/b.spec.tsx'])
  })

  test('int specs are test/**/*int.spec.ts', () => {
    write('test/fields/int.spec.ts', 'test/queues/a.int.spec.ts', 'packages/x/int.spec.ts')
    const { coveredBy } = run()
    assert.deepEqual(coveredBy.get('test/fields/int.spec.ts'), ['tests-int'])
    assert.deepEqual(coveredBy.get('test/queues/a.int.spec.ts'), ['tests-int'])
    assert.deepEqual(coveredBy.get('packages/x/int.spec.ts'), ['tests-unit'])
  })

  test('only templates in the main.yml matrix are run', () => {
    write('templates/blank/tests/e2e/a.e2e.spec.ts', 'templates/ecommerce/tests/e2e/a.e2e.spec.ts')
    assert.deepEqual(run().uncovered, ['templates/ecommerce/tests/e2e/a.e2e.spec.ts'])
  })

  test('node_modules and dist are not scanned', () => {
    write('packages/a/node_modules/dep/x.spec.ts', 'packages/a/dist/y.spec.ts')
    assert.deepEqual(run().specs, [])
  })
})

describe('rule sources', () => {
  test('rules agree with the repo files they were derived from', () => {
    assert.deepEqual(checkRuleSources(realRoot, rulesFor()), [])
  })

  test('a rule whose source no longer says so is reported', () => {
    write(
      'vitest.config.ts',
      'package.json',
      '.github/workflows/main.yml',
      '.github/scripts/visual/run-visual-suites.sh',
      'test/runE2E.ts',
    )
    writeFileSync(path.join(tree, '.github/workflows/main.yml'), 'jobs:\n  tests-unit:\n    name: x\n')
    const problems = checkRuleSources(tree, rulesFor())
    assert.match(problems.join('\n'), /vitest\.config\.ts no longer contains "'packages\/\*\*\/\*\.spec\.ts'"/)
    assert.match(problems.join('\n'), /job "tests-int" is not in main\.yml/)
  })
})
