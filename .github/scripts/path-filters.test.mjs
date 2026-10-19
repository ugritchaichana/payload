import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { isMatch } from './lib/glob.mjs'
import { parseFilters } from './lib/workflow.mjs'

const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')
const workflow = process.env.MAIN_YML ?? path.join(root, '.github/workflows/main.yml')
const filters = parseFilters(readFileSync(workflow, 'utf8'))

/** dorny/paths-filter: a filter is true when any changed file matches any of its patterns. */
const selects = (filter, changedFiles) =>
  changedFiles.some((file) => filters[filter].some((pattern) => isMatch(file, pattern)))

describe('glob matcher agrees with picomatch@2.3.1 { dot: true } (dorny/paths-filter)', () => {
  // Expected values come from running picomatch 2.3.1 itself, not from this implementation.
  const golden = [
    ['a/**', 'a', true],
    ['a/**', 'a/b/c', true],
    ['**/x.ts', 'x.ts', true],
    ['**/x.ts', 'a/x.ts', true],
    ['*.json', 'a/b.json', false],
    ['*.json', 'b.json', true],
    ['tsconfig*.json', 'tsconfig.base.json', true],
    ['tsconfig*.json', 'packages/a/tsconfig.json', false],
    ['.github/workflows/*.config.ts', '.github/workflows/e2e.config.ts', true],
    ['.github/workflows/*.config.ts', '.github/workflows/utilities/e2e.config.ts', false],
    ['packages/**/*.tsx', 'packages/a.tsx', true],
    ['test/**/e2e.spec.ts', 'test/e2e.spec.ts', true],
    ['test/**/e2e.spec.ts', 'test/a/xe2e.spec.ts', false],
    ['{a,b}/c', 'a/c', true],
    ['a?c', 'a/c', false],
    ['**', '.github/x', true],
    ['*', '.env', true],
    ['test/**/*int.spec.ts', 'test/int.spec.ts', true],
    ['a/**/b/**', 'a/b', true],
    ['a/**/b/**', 'a/x/b/y', true],
  ]
  for (const [pattern, file, expected] of golden) {
    test(`${pattern} vs ${file} is ${expected}`, () => {
      assert.equal(isMatch(file, pattern), expected)
    })
  }
})

describe('path filters select the tests for files that can change their outcome', () => {
  // Changed files of real main commits, each with the run that skipped the tests.
  const holes = [
    {
      name: 'Node bump in .tool-versions (commit d95c365a, run 21375798007)',
      files: ['.node-version', '.nvmrc', '.tool-versions', 'CONTRIBUTING.md'],
    },
    {
      name: 'tools/releaser spec (commit ecd6c514, run 37358913291)',
      files: [
        '.github/workflows/publish-release.yml',
        '.github/workflows/release-bump.yml',
        'tools/releaser/src/lib/bumpVersion.spec.ts',
      ],
    },
    {
      name: 'tools/releaser source (commit ed9181a2, run 36754668806)',
      files: [
        'tools/releaser/src/release-ci.spec.ts',
        'tools/releaser/src/release-ci.ts',
        'tools/releaser/src/utils/generateReleaseNotes.ts',
      ],
    },
    {
      name: 'tools/releaser publish list (commit 82565d2b, run 29855107801)',
      files: ['tools/releaser/src/lib/publishList.ts'],
    },
    {
      name: 'E2E matrix config (commit fcdb7ba6, run 25390148541)',
      files: ['.github/workflows/e2e.config.ts'],
    },
    {
      name: 'setup action (commit 479b0573, run 21375804026; commit fe9119bb, run 20820270424)',
      files: ['.github/actions/setup/action.yml'],
    },
    { name: 'int matrix config', files: ['.github/workflows/int.config.ts'] },
    { name: 'matrix utilities', files: ['.github/workflows/utilities/int-matrix.ts'] },
    { name: 'setup-playwright action', files: ['.github/actions/setup-playwright/action.yml'] },
    { name: 'root tsconfig', files: ['tsconfig.base.json'] },
    { name: 'turbo.json', files: ['turbo.json'] },
    { name: 'pnpm-workspace.yaml', files: ['pnpm-workspace.yaml'] },
    { name: 'tstyche.json (selects the type tests)', files: ['tstyche.json'] },
  ]
  for (const { name, files } of holes) {
    test(`${name}: needs_tests and needs_build`, () => {
      assert.equal(selects('needs_tests', files), true, 'needs_tests')
      assert.equal(selects('needs_build', files), true, 'needs_build')
    })
  }

  // Paths that stay unselected, each with the reason it cannot change a test outcome.
  const irrelevant = [
    { name: 'README.md only', files: ['README.md'] },
    { name: 'docs only', files: ['docs/getting-started/installation.mdx'] },
    {
      name: 'root scripts/ (dev, clean, docker helpers; commit f9e75a4e run 18530453069, commit 03bfaf46 run 21728094548)',
      files: ['scripts/audit-dependencies.mjs', 'scripts/delete-recursively.js'],
    },
    {
      name: 'ai-reviewer action, used by no main.yml job (commit 5e3a1c50, run 26119936724)',
      files: [
        '.github/actions/ai-reviewer/src/review.ts',
        '.github/ai-reviewer-prompt.md',
        '.github/workflows/ai-reviewer.yml',
      ],
    },
    {
      name: 'agent skill scripts (commit 0e21f2c1, run 38803968311)',
      files: ['.agents/skills/record-pr-demo/scripts/record-demo.mjs'],
    },
    { name: '.nvmrc / .node-version, read by no job', files: ['.nvmrc', '.node-version'] },
  ]
  for (const { name, files } of irrelevant) {
    test(`${name}: selects nothing`, () => {
      for (const filter of Object.keys(filters)) {
        assert.equal(selects(filter, files), false, filter)
      }
    })
  }

  test('files that already selected tests still do', () => {
    const files = [
      'packages/payload/src/index.ts',
      'test/fields/int.spec.ts',
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.ts',
      '.github/workflows/main.yml',
      '.github/actions/start-services/action.yml',
    ]
    for (const file of files) {
      assert.equal(selects('needs_tests', [file]), true, file)
      assert.equal(selects('needs_build', [file]), true, file)
    }
  })

  test('pipeline scripts and the quarantine and reachability lists select build and tests', () => {
    const files = [
      '.github/scripts/gate.mjs',
      '.github/scripts/e2e-leg.mjs',
      '.github/scripts/lib/e2e-report.mjs',
      '.github/scripts/quarantine.test.mjs',
      '.github/test-quarantine.json',
      '.github/test-reachability-exclusions.json',
    ]
    for (const file of files) {
      assert.equal(selects('needs_tests', [file]), true, `needs_tests ${file}`)
      assert.equal(selects('needs_build', [file]), true, `needs_build ${file}`)
    }
  })

  test('other .github files still select nothing', () => {
    for (const file of [
      '.github/CODEOWNERS',
      '.github/ai-reviewer-prompt.md',
      '.github/workflows/stale.yml',
    ]) {
      for (const filter of ['needs_tests', 'needs_build']) {
        assert.equal(selects(filter, [file]), false, `${filter} ${file}`)
      }
    }
  })

  test('every needs_tests pattern is also a needs_build pattern (tests depend on build)', () => {
    const missing = filters.needs_tests.filter((pattern) => !filters.needs_build.includes(pattern))
    assert.deepEqual(missing, [])
  })

  test('needs_visual selects on package.json, pnpm-lock.yaml and .tool-versions (Playwright or Node bump)', () => {
    for (const file of ['package.json', 'pnpm-lock.yaml', '.tool-versions']) {
      assert.equal(selects('needs_visual', [file]), true, file)
    }
  })

  test('templates-only change still builds but does not run the test families', () => {
    assert.equal(selects('needs_build', ['templates/blank/package.json']), true)
    assert.equal(selects('needs_tests', ['templates/blank/package.json']), false)
  })
})
