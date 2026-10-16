import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  entryKey,
  entryRegexSource,
  LIFETIME_DAYS,
  lint,
  quarantineMatrix,
  readQuarantine,
  renderReport,
  selection,
} from './quarantine.mjs'

const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')
const script = path.join(import.meta.dirname, 'quarantine.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'quarantine-'))
let counter = 0
const freshFile = (name) => path.join(dir, `${counter++}-${name}`)

const real = readQuarantine()
const realMatrixText = spawnSync(
  process.execPath,
  [path.join(root, '.github/workflows/e2e.config.ts')],
  {
    encoding: 'utf8',
  },
).stdout
const SPEC = 'describe("Auth") it("works fine") test("another one")'

const entry = (over = {}) => ({
  added: '2026-10-16',
  evidence: { flakyRuns: 10, greenMainRuns: 39, ratePercent: 26, window: 'last 100 main runs' },
  expires: '2026-11-15',
  file: 'test/auth/e2e.spec.ts',
  framework: 'next',
  line: 12,
  reason: 'flaky',
  suites: ['auth'],
  titlePath: ['Auth', 'works fine'],
  ...over,
})
const problems = (entries, now = '2026-10-20', specText = () => SPEC) =>
  lint(entries, { now, specText })

describe('the committed quarantine list', () => {
  test('has the 22 framework and test pairs that flaked in at least 25% of green main runs', () => {
    assert.equal(real.length, 22)
    for (const e of real) {
      assert.ok(e.evidence.flakyRuns / e.evidence.greenMainRuns >= 0.25, e.titlePath.at(-1))
    }
  })

  test('lints clean on the day it was added, and fails on every entry once expired', () => {
    const specText = (file) => readFileSync(path.join(root, file), 'utf8')
    assert.deepEqual(lint(real, { now: real[0].added, specText }), [])
    const expired = lint(real, { now: real[0].expires.replace(/\d\d$/, '30'), specText })
    assert.equal(expired.length, 22)
    assert.match(expired[0], /expired on 2026-11-15: review it/)
  })

  test('every entry names a suite that exists in the real E2E matrix', () => {
    assert.doesNotThrow(() => quarantineMatrix(real, realMatrixText))
  })

  test('every entry has a regex that matches its own Playwright title and no other entry', () => {
    const titles = real.map((e) =>
      ['chromium', e.file.replace(/^test\//, ''), ...e.titlePath].join(' '),
    )
    real.forEach((e, i) => {
      const re = new RegExp(entryRegexSource(e))
      titles.forEach((title, j) => {
        assert.equal(re.test(title), title === titles[i], `${i} vs ${j}`)
      })
    })
  })
})

describe('lint: each rule fails', () => {
  test('a valid entry passes', () => {
    assert.deepEqual(problems([entry()]), [])
  })

  const bad = (name, over, pattern, now) =>
    test(name, () => {
      const result = problems([entry(over)], now)
      assert.ok(result.length > 0, 'expected a problem')
      assert.match(result.join('\n'), pattern)
    })

  bad('expired entry forces a review', {}, /expired on 2026-11-15: review it/, '2026-11-16')
  test('an entry is still valid on its expiry day', () => {
    assert.deepEqual(problems([entry()], '2026-11-15'), [])
  })
  bad(
    'expiry that is not added + 30 days',
    { expires: '2026-12-31' },
    /expires must be added \+ 30 days \(2026-11-15\)/,
  )
  bad('added in the future', { added: '2026-10-25', expires: '2026-11-24' }, /in the future/)
  bad('unparsable dates', { added: '16/10/2026' }, /added and expires must be YYYY-MM-DD/)
  bad(
    'flaky rate below the 25% criterion',
    { evidence: { flakyRuns: 5, greenMainRuns: 39, ratePercent: 13, window: 'w' } },
    /below 25%/,
  )
  bad(
    'rate that does not follow from the runs',
    { evidence: { flakyRuns: 10, greenMainRuns: 39, ratePercent: 99, window: 'w' } },
    /ratePercent does not equal/,
  )
  bad(
    'missing evidence',
    { evidence: undefined },
    /evidence needs integer flakyRuns and greenMainRuns/,
  )
  bad('missing reason', { reason: ' ' }, /reason is required/)
  bad('unknown framework', { framework: 'remix' }, /framework must be one of/)
  bad('no suites', { suites: [] }, /suites must list at least one/)
  bad(
    'file that is not an e2e spec',
    { file: 'test/auth/config.ts' },
    /file must be a test\/\*\*\/\*e2e\.spec\.ts path/,
  )
  bad('bad line number', { line: 0 }, /line must be a positive integer/)
  bad('empty title path', { titlePath: [] }, /titlePath must be/)
  test('a spec file that does not exist', () => {
    assert.match(problems([entry()], '2026-10-20', () => null).join('\n'), /does not exist/)
  })
  test('a title that no longer appears in the spec file', () => {
    assert.match(
      problems([entry({ titlePath: ['Auth', 'was renamed'] })]).join('\n'),
      /title "was renamed" does not appear/,
    )
  })
  test('the same test twice for one framework', () => {
    assert.match(problems([entry(), entry()]).join('\n'), /duplicate of an earlier entry/)
  })
  test('the same test for two frameworks is fine', () => {
    assert.deepEqual(problems([entry(), entry({ framework: 'tanstack-start' })]), [])
  })
  test('lifetime is the 30 days of the policy', () => {
    assert.equal(LIFETIME_DAYS, 30)
  })
})

describe('selection: gating legs exclude what the quarantine leg runs', () => {
  const entries = [
    entry({ suites: ['auth', 'auth#config.other.ts'] }),
    entry({ framework: 'tanstack-start', titlePath: ['Auth', 'another one'] }),
  ]

  test('exclude gives grepInvert for the entries of that framework and suite only', () => {
    const result = selection(entries, { framework: 'next', mode: 'exclude', suite: 'auth' })
    assert.deepEqual(Object.keys(result), ['grepInvert'])
    assert.equal(result.grepInvert.length, 1)
    assert.deepEqual(
      selection(entries, { framework: 'next', mode: 'exclude', suite: 'versions' }),
      {},
    )
    assert.deepEqual(
      selection(entries, { framework: 'next', mode: 'exclude', suite: 'auth#config.other.ts' })
        .grepInvert.length,
      1,
    )
  })

  test('only gives grep with the same regexes that exclude removes', () => {
    for (const framework of ['next', 'tanstack-start']) {
      for (const suite of ['auth', 'auth#config.other.ts', 'versions']) {
        const out = selection(entries, { framework, mode: 'exclude', suite }).grepInvert
        const only = selection(entries, { framework, mode: 'only', suite }).grep
        assert.deepEqual(out, only, `${framework} ${suite}`)
      }
    }
  })

  test('on the real list and matrix every entry is excluded where it runs and run in quarantine', () => {
    const legs = JSON.parse(realMatrixText).include
    const matrix = quarantineMatrix(real, realMatrixText).include
    for (const e of real) {
      for (const suite of e.suites) {
        const gating = legs.filter((l) => l.framework === e.framework && l.suite === suite)
        assert.ok(gating.length >= 1)
        for (const leg of gating) {
          const out = selection(real, { framework: e.framework, mode: 'exclude', suite: leg.suite })
          assert.ok(out.grepInvert.includes(entryRegexSource(e)))
        }
        const quarantine = matrix.filter((m) => m.framework === e.framework && m.suite === suite)
        assert.equal(quarantine.length, 1, `${e.framework} ${suite} has exactly one quarantine leg`)
        assert.ok(
          selection(real, { framework: e.framework, mode: 'only', suite }).grep.includes(
            entryRegexSource(e),
          ),
        )
      }
    }
    for (const group of matrix) {
      assert.equal(typeof group.parallel, 'boolean')
    }
  })

  test('an unknown mode throws', () => {
    assert.throws(
      () => selection(entries, { framework: 'next', mode: 'both', suite: 'auth' }),
      /mode must be/,
    )
  })
})

describe('quarantineMatrix', () => {
  const matrixText = JSON.stringify({
    include: [
      { framework: 'next', parallel: false, shard: 1, suite: 'auth', 'total-shards': 1 },
      {
        framework: 'next',
        parallel: false,
        shard: 1,
        suite: 'auth#config.other.ts',
        'total-shards': 1,
      },
      { framework: 'tanstack-start', parallel: false, shard: 1, suite: 'auth', 'total-shards': 1 },
    ],
  })

  test('one leg per framework and suite, counting tests', () => {
    const matrix = quarantineMatrix(
      [
        entry({ suites: ['auth', 'auth#config.other.ts'] }),
        entry({ titlePath: ['Auth', 'another one'] }),
      ],
      matrixText,
    )
    assert.deepEqual(
      matrix.include.map((m) => [m.framework, m.suite, m.tests]),
      [
        ['next', 'auth', 2],
        ['next', 'auth#config.other.ts', 1],
      ],
    )
  })

  test('an entry whose suite is not in the E2E matrix fails', () => {
    assert.throws(
      () => quarantineMatrix([entry({ suites: ['removed-suite'] })], matrixText),
      /no E2E leg for next removed-suite/,
    )
    assert.throws(() =>
      quarantineMatrix(
        [entry({ framework: 'tanstack-start', suites: ['auth#config.other.ts'] })],
        matrixText,
      ),
    )
  })

  test('an empty list gives no legs', () => {
    assert.deepEqual(quarantineMatrix([], matrixText).include, [])
  })
})

describe('renderReport', () => {
  const e = entry({ suites: ['auth'] })
  const verdict = (outcome) => ({
    leg: { framework: 'next', suite: 'auth' },
    tests: [{ file: e.file, outcome, title: e.titlePath.join(' > ') }],
  })

  test('a test that failed every attempt is listed first and annotated', () => {
    const report = renderReport([e], [verdict('failed')])
    assert.equal(report.problems, 1)
    assert.match(report.summary, /### ATTENTION: 1 quarantined test results need a look/)
    assert.match(report.summary, /FAILED ON EVERY ATTEMPT/)
    assert.match(
      report.annotations[0],
      /^::warning title=Quarantined test::next auth test\/auth\/e2e\.spec\.ts:12 works fine/,
    )
  })

  test('a test with no result is shown as not run, not as passed', () => {
    const report = renderReport([e], [])
    assert.equal(report.problems, 1)
    assert.match(report.summary, /NOT RUN/)
  })

  test('passed and flaky outcomes need no attention', () => {
    for (const outcome of ['passed', 'flaky']) {
      const report = renderReport([e], [verdict(outcome)])
      assert.equal(report.problems, 0, outcome)
      assert.doesNotMatch(report.summary, /ATTENTION/)
    }
    assert.match(renderReport([e], [verdict('flaky')]).summary, /passed after an in-job retry/)
  })

  test('titles with pipes do not break the table', () => {
    const piped = entry({ titlePath: ['Auth', 'a | b'] })
    assert.match(renderReport([piped], []).summary, /a \\\| b/)
  })

  test('entryKey ties a result to its entry by file and title', () => {
    assert.equal(entryKey(e), `${e.file}\u0000Auth > works fine`)
  })
})

describe('command line', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    })

  test('lint: exits 0 on the committed list today and 1 once it has expired', () => {
    assert.equal(run(['lint', '--now', real[0].added]).status, 0)
    const expired = run(['lint', '--now', '2027-01-01'])
    assert.equal(expired.status, 1)
    assert.match(expired.stdout, /::error title=Test quarantine::/)
  })

  test('select writes the selection file the Playwright config reads', () => {
    const out = freshFile('selection.json')
    const result = run([
      'select',
      '--framework',
      'next',
      '--suite',
      'auth',
      '--mode',
      'exclude',
      '--out',
      out,
    ])
    assert.equal(result.status, 0, result.stderr)
    const { grepInvert } = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(grepInvert.length, 1)
    const none = freshFile('none.json')
    run(['select', '--framework', 'next', '--suite', 'a11y', '--mode', 'exclude', '--out', none])
    assert.deepEqual(JSON.parse(readFileSync(none, 'utf8')), {})
  })

  test('matrix writes the quarantine matrix and its count to GITHUB_OUTPUT', () => {
    const out = freshFile('output')
    const result = run(['matrix'], { E2E_MATRIX: realMatrixText, GITHUB_OUTPUT: out })
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(out, 'utf8')
    assert.match(text, /^quarantine_count=21$/m)
    assert.match(text, /^quarantine_matrix=\{"include":\[/m)
  })

  test('matrix fails on a suite the E2E matrix does not have', () => {
    const file = freshFile('list.json')
    writeFileSync(file, JSON.stringify({ entries: [entry({ suites: ['gone'] })], schema: 1 }))
    const result = run(['matrix', '--file', file], { E2E_MATRIX: realMatrixText })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no E2E leg for next gone/)
  })

  test('report prints failures first and never fails the step', () => {
    const results = freshFile('results')
    mkdirSync(results)
    const target = real[2]
    writeFileSync(
      path.join(results, 'quarantine-result-0.json'),
      JSON.stringify({
        leg: { framework: target.framework, suite: target.suites[0] },
        tests: [{ file: target.file, outcome: 'failed', title: target.titlePath.join(' > ') }],
      }),
    )
    const summary = freshFile('summary.md')
    const result = run(['report', '--dir', results], { GITHUB_STEP_SUMMARY: summary })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /::warning title=Quarantined test::/)
    assert.match(readFileSync(summary, 'utf8'), /FAILED ON EVERY ATTEMPT/)
  })
})

describe('Playwright config', () => {
  test('applies the selection file, and the in-job retry counts are unchanged', () => {
    const config = readFileSync(path.join(root, 'test/playwright.config.ts'), 'utf8')
    assert.match(config, /process\.env\.PLAYWRIGHT_SELECTION_FILE/)
    assert.match(config, /grep: toRegExps\(selection\.grep\)/)
    assert.match(config, /grepInvert: toRegExps\(selection\.grepInvert\)/)
    assert.match(config, /retries: CI \? \(isTanStack \? 2 : 5\) : undefined/)
    const vitest = readFileSync(path.join(root, 'vitest.config.ts'), 'utf8')
    assert.match(vitest, /retry: process\.env\.CI \? 2 : 0/)
  })
})
