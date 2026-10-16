import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  buildPlan,
  buildVerdict,
  checkVerdict,
  rescuedAsFlaky,
  retrySelection,
} from './e2e-leg.mjs'
import { classify, legKey, readReports, titleRegexSource } from './lib/e2e-report.mjs'
import { parseJobs } from './lib/workflow.mjs'

const script = path.join(import.meta.dirname, 'e2e-leg.mjs')
const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')
const dir = mkdtempSync(path.join(tmpdir(), 'e2e-leg-'))
let counter = 0
const freshDir = () => {
  const made = path.join(dir, `case-${counter++}`)
  mkdirSync(made)
  return made
}

/**
 * Reports in the shape of Playwright 1.63.0's JSON reporter (checked against real output):
 * file suites > describe suites > specs > tests, each test with `results[]` per attempt.
 */
function reportOf(tests, { errors = [], stats } = {}) {
  const files = new Map()
  const counts = { expected: 0, flaky: 0, skipped: 0, unexpected: 0 }
  for (const t of tests) {
    const {
      attempts = [t.status === 'unexpected' ? 'failed' : 'passed'],
      describes = [],
      expectedStatus = 'passed',
      file = 'auth/e2e.spec.ts',
      line = 10,
      specFile = file,
      status = 'expected',
      title,
    } = t
    counts[status]++
    let fileSuite = files.get(file)
    if (!fileSuite) {
      fileSuite = { file, line: 0, specs: [], suites: [], title: file.replace(/\//g, '\\') }
      files.set(file, fileSuite)
    }
    let suite = fileSuite
    for (const name of describes) {
      let child = suite.suites.find((s) => s.title === name)
      if (!child) {
        child = { file, line: 1, specs: [], suites: [], title: name }
        suite.suites.push(child)
      }
      suite = child
    }
    suite.specs.push({
      file: specFile,
      line,
      ok: status !== 'unexpected',
      tags: [],
      tests: [
        {
          expectedStatus,
          projectName: 'chromium',
          results: attempts.map((s, retry) => ({
            error:
              s === 'passed'
                ? undefined
                : { message: t.errorMessage ?? `\u001b[31mError: ${title} ${s}\u001b[39m\nmore` },
            retry,
            status: s,
          })),
          status,
        },
      ],
      title,
    })
  }
  return {
    config: {},
    errors,
    stats: stats ?? { duration: 1, ...counts },
    suites: [...files.values()],
  }
}

const passing = (title, extra) => ({ attempts: ['passed'], title, ...extra })
const flaky = (title, extra) => ({
  attempts: ['failed', 'passed'],
  status: 'flaky',
  title,
  ...extra,
})
const failing = (title, extra) => ({
  attempts: ['failed', 'failed', 'failed'],
  status: 'unexpected',
  title,
  ...extra,
})
const parse = (report) => JSON.parse(JSON.stringify(report))

const LEG = { cacheComponents: false, framework: 'next', shard: 1, suite: 'auth', totalShards: 1 }
const writeReport = (folder, report, name = 'results_auth_next_1.json') =>
  writeFileSync(path.join(folder, name), JSON.stringify(report))

describe('classify: what a leg exit code and report mean', () => {
  test('exit 0 with only passing and flaky tests is a pass', () => {
    const result = classify({
      exitCode: 0,
      report: parse(
        reportOf([
          passing('a'),
          flaky('b'),
          { ...passing('c'), expectedStatus: 'skipped', status: 'skipped', attempts: ['skipped'] },
        ]),
      ),
    })
    assert.equal(result.verdict, 'pass')
    assert.equal(result.stats.executed, 2)
    assert.deepEqual(result.failed, [])
  })

  test('failed and timed out tests are test-level failures, with repo-relative identity', () => {
    const report = reportOf([
      passing('steady'),
      failing('first', { describes: ['Auth', 'Inner'], line: 297 }),
      failing('second', { attempts: ['timedOut', 'timedOut'] }),
    ])
    const result = classify({ exitCode: 1, report: parse(report) })
    assert.equal(result.verdict, 'test-failures')
    const byTitle = Object.fromEntries(result.failed.map((t) => [t.title, t]))
    assert.deepEqual(Object.keys(byTitle).sort(), ['Auth > Inner > first', 'second'])
    assert.deepEqual(
      [
        byTitle['Auth > Inner > first'].file,
        byTitle['Auth > Inner > first'].line,
        byTitle['Auth > Inner > first'].attempts,
      ],
      ['test/auth/e2e.spec.ts', 297, 3],
    )
    assert.equal(byTitle.second.attempts, 2)
    assert.equal(byTitle['Auth > Inner > first'].error, 'Error: first failed')
  })

  test('a helper-defined test is identified by the spec file that was loaded', () => {
    const report = reportOf([
      failing('wrapped', {
        file: 'admin/e2e/general/e2e.spec.ts',
        line: 49,
        specFile: '__helpers/e2e/playwright.ts',
      }),
    ])
    const [failed] = classify({ exitCode: 1, report: parse(report) }).failed
    assert.equal(failed.file, 'test/admin/e2e/general/e2e.spec.ts')
  })

  test('a test that was skipped on purpose is not a failure to run', () => {
    const report = reportOf([
      passing('a'),
      { attempts: ['skipped'], expectedStatus: 'skipped', status: 'skipped', title: 'fixme' },
    ])
    assert.equal(classify({ exitCode: 0, report: parse(report) }).verdict, 'pass')
  })

  const infra = (name, exitCode, report, reason) =>
    test(`infra: ${name}`, () => {
      const result = classify({ exitCode, report: parse(report) })
      assert.equal(result.verdict, 'infra')
      assert.match(result.reason, reason)
      assert.deepEqual(result.failed, [])
    })

  infra(
    'exit 1 without any failed test (setup, crash, timeout)',
    1,
    reportOf([passing('a')]),
    /exit code 1 without a failed test/,
  )
  infra(
    'a global error such as maxFailures or a syntax error',
    1,
    reportOf([failing('a')], {
      errors: [
        { message: '\u001b[31mTesting stopped early after 30 maximum allowed failures.\u001b[39m' },
      ],
    }),
    /Playwright reported an error: Testing stopped early/,
  )
  infra(
    'tests that did not run after maxFailures',
    1,
    reportOf([failing('a'), { attempts: [], status: 'skipped', title: 'never started' }]),
    /1 tests did not run \(first: never started\)/,
  )
  infra(
    'tests skipped after a failed beforeAll',
    1,
    reportOf([
      failing('a'),
      { attempts: ['skipped', 'skipped'], status: 'skipped', title: 'second in hook' },
    ]),
    /did not run/,
  )
  infra(
    'an interrupted test',
    1,
    reportOf([{ attempts: ['failed', 'interrupted'], status: 'unexpected', title: 'cut off' }]),
    /interrupted/,
  )
  infra(
    'exit 0 but the report holds a failed test',
    0,
    reportOf([failing('a')]),
    /exit code 0 but 1 failed tests/,
  )
  infra(
    'stats that disagree with the tests',
    1,
    reportOf([failing('a')], { stats: { expected: 0, flaky: 0, skipped: 0, unexpected: 2 } }),
    /inconsistent/,
  )
  infra(
    'an unexpected test that did not end failed or timed out',
    1,
    reportOf([{ attempts: ['failed', 'skipped'], status: 'unexpected', title: 'odd' }]),
    /did not end failed or timedOut/,
  )
  infra(
    'a worker process that exited during a test',
    1,
    reportOf([
      failing('crashes', {
        errorMessage: 'Error: worker process exited unexpectedly (code=3, signal=null)',
      }),
    ]),
    /1 tests lost their worker process \(first: crashes\)/,
  )
  test('infra: an exit code that is not a number', () => {
    const result = classify({ exitCode: Number.NaN, report: parse(reportOf([passing('a')])) })
    assert.equal(result.verdict, 'infra')
  })
})

describe('retry selection regex', () => {
  const grepTitle = (project, file, titles) => [project, file, ...titles].join(' ')
  const sourceFor = (file, titlePath) => titleRegexSource({ fileTitle: file, titlePath })

  test('matches the string Playwright greps, on both path separators', () => {
    const source = sourceFor('admin/e2e/general/e2e.spec.ts', ['General', 'i18n', 'labels (a|b)'])
    const re = new RegExp(source)
    assert.ok(
      re.test(
        grepTitle('chromium', 'admin/e2e/general/e2e.spec.ts', ['General', 'i18n', 'labels (a|b)']),
      ),
    )
    assert.ok(
      re.test(
        grepTitle('chromium', 'admin\\e2e\\general\\e2e.spec.ts', [
          'General',
          'i18n',
          'labels (a|b)',
        ]),
      ),
    )
    assert.ok(
      re.test(
        `${grepTitle('chromium', 'admin/e2e/general/e2e.spec.ts', ['General', 'i18n', 'labels (a|b)'])} @slow`,
      ),
    )
  })

  test('does not match a test with the same title in another file or a longer title', () => {
    const re = new RegExp(sourceFor('auth/e2e.spec.ts', ['Auth', 'should work']))
    assert.equal(
      re.test(grepTitle('chromium', 'auth-basic/e2e.spec.ts', ['Auth', 'should work'])),
      false,
    )
    assert.equal(
      re.test(grepTitle('chromium', 'auth/e2e.spec.ts', ['Auth', 'should work twice'])),
      false,
    )
    assert.equal(
      re.test(grepTitle('chromium', 'auth/e2e.spec.ts', ['Outer', 'Auth', 'should work'])),
      false,
    )
  })

  test('escapes backticks, brackets and regex characters in titles', () => {
    const title = 'should have `useAuth` hook [a] (b) $1 + *'
    const re = new RegExp(sourceFor('auth/e2e.spec.ts', [title]))
    assert.ok(re.test(grepTitle('chromium', 'auth/e2e.spec.ts', [title])))
  })
})

describe('buildVerdict', () => {
  const reportsOf = (...reports) => ({
    names: reports.map((_, i) => `results_${i}.json`),
    problems: [],
    reports: reports.map((report, i) => ({ name: `results_${i}.json`, report: parse(report) })),
  })
  const base = { kind: 'first', leg: LEG }

  test('a leg with no Playwright report is infra', () => {
    const verdict = buildVerdict({
      ...base,
      exitCode: 1,
      reports: { names: [], problems: [], reports: [] },
    })
    assert.equal(verdict.verdict, 'infra')
    assert.match(verdict.reason, /found 0 Playwright JSON reports/)
  })

  test('an exit 0 leg with no report is infra too: the pass cannot be shown', () => {
    const verdict = buildVerdict({
      ...base,
      exitCode: 0,
      reports: { names: [], problems: [], reports: [] },
    })
    assert.equal(verdict.verdict, 'infra')
  })

  test('an unreadable report is infra', () => {
    const verdict = buildVerdict({
      ...base,
      exitCode: 1,
      reports: {
        names: ['results_a.json'],
        problems: ['results_a.json: not valid JSON'],
        reports: [],
      },
    })
    assert.equal(verdict.verdict, 'infra')
    assert.match(verdict.reason, /unreadable Playwright report/)
  })

  test('two reports are infra: it is not clear which one is this leg', () => {
    const verdict = buildVerdict({
      ...base,
      exitCode: 0,
      reports: reportsOf(reportOf([]), reportOf([])),
    })
    assert.equal(verdict.verdict, 'infra')
  })

  test('a passing leg and a leg with test failures', () => {
    assert.equal(
      buildVerdict({ ...base, exitCode: 0, reports: reportsOf(reportOf([passing('a')])) }).verdict,
      'pass',
    )
    const failed = buildVerdict({
      ...base,
      exitCode: 1,
      reports: reportsOf(reportOf([failing('a')])),
    })
    assert.equal(failed.verdict, 'test-failures')
    assert.equal(checkVerdict(JSON.parse(JSON.stringify(failed))), '')
  })

  test('a quarantine verdict lists every test with its outcome', () => {
    const verdict = buildVerdict({
      exitCode: 1,
      kind: 'quarantine',
      leg: LEG,
      reports: reportsOf(reportOf([passing('a'), flaky('b'), failing('c')])),
    })
    assert.deepEqual(
      verdict.tests.map((t) => [t.title, t.outcome]),
      [
        ['a', 'passed'],
        ['b', 'flaky'],
        ['c', 'failed'],
      ],
    )
  })

  describe('retry kind', () => {
    const firstRun = classify({
      exitCode: 1,
      report: parse(reportOf([failing('a', { line: 5 }), failing('b', { line: 6 })])),
    }).failed
    const plan = { planId: '9-1', retry: [{ key: legKey(LEG), tests: firstRun }] }
    const retry = (exitCode, tests) =>
      buildVerdict({
        exitCode,
        kind: 'retry',
        leg: LEG,
        plan,
        reports: reportsOf(reportOf(tests)),
        retryIndex: 0,
      })

    test('every planned test passes: pass, with the plan id and key', () => {
      const verdict = retry(0, [passing('a', { line: 5 }), flaky('b', { line: 6 })])
      assert.equal(verdict.verdict, 'pass')
      assert.equal(verdict.planId, '9-1')
      assert.equal(verdict.key, legKey(LEG))
      assert.deepEqual(
        verdict.outcomes.map((o) => o.outcome),
        ['passed', 'passed'],
      )
    })

    test('a planned test that fails again makes the retry leg test-failures', () => {
      const verdict = retry(1, [passing('a'), failing('b')])
      assert.equal(verdict.verdict, 'test-failures')
      assert.deepEqual(
        verdict.outcomes.map((o) => o.outcome),
        ['passed', 'failed'],
      )
    })

    test('a planned test missing from the retry report is infra: the retry did not cover it', () => {
      const verdict = retry(0, [passing('a')])
      assert.equal(verdict.verdict, 'infra')
      assert.match(
        verdict.reason,
        /1 planned tests were not found in the retry report \(first: b\)/,
      )
    })

    test('an unplanned test that fails in the retry leg is also a failure', () => {
      const verdict = retry(1, [passing('a'), passing('b'), failing('extra')])
      assert.equal(verdict.verdict, 'test-failures')
    })

    test('an infra problem in the retry leg stays infra', () => {
      const verdict = retry(1, [passing('a'), passing('b')])
      assert.equal(verdict.verdict, 'infra')
    })

    test('a retry leg with no plan entry is infra', () => {
      const verdict = buildVerdict({
        exitCode: 0,
        kind: 'retry',
        leg: LEG,
        plan: { planId: '9-1', retry: [] },
        reports: reportsOf(reportOf([passing('a')])),
        retryIndex: 0,
      })
      assert.equal(verdict.verdict, 'infra')
      assert.match(verdict.reason, /no retry plan entry/)
    })

    test('rescued tests become flaky entries marked as a fresh-runner retry', () => {
      const verdict = retry(0, [passing('a', { line: 5 }), passing('b', { line: 6 })])
      const entries = rescuedAsFlaky({ framework: 'next', plan, verdict })
      assert.deepEqual(
        entries.map((e) => [e.title, e.via, e.retries, e.framework]),
        [
          ['a', 'fresh-runner retry', 2, 'next'],
          ['b', 'fresh-runner retry', 2, 'next'],
        ],
      )
      assert.match(entries[0].error, /a failed/)
    })
  })
})

describe('buildPlan', () => {
  const matrixText = JSON.stringify({
    include: [
      {
        cacheComponents: false,
        framework: 'next',
        parallel: false,
        shard: 1,
        suite: 'auth',
        'total-shards': 1,
      },
      {
        cacheComponents: false,
        framework: 'next',
        parallel: true,
        shard: 1,
        suite: 'versions',
        'total-shards': 2,
      },
      {
        cacheComponents: false,
        framework: 'next',
        parallel: true,
        shard: 2,
        suite: 'versions',
        'total-shards': 2,
      },
    ],
  })
  const legOf = (suite, shard, total) => ({ ...LEG, shard, suite, totalShards: total })
  const verdictFile = (name, leg, verdict, failed = []) => ({
    name,
    text: JSON.stringify({
      exitCode: 1,
      failed,
      kind: 'first',
      leg,
      reason: 'r',
      schema: 1,
      verdict,
    }),
  })
  const test1 = classify({ exitCode: 1, report: parse(reportOf([failing('a')])) }).failed
  const plan = (verdictFiles) =>
    buildPlan({ matrixText, runAttempt: '2', runId: '55', verdictFiles })

  const all = [
    verdictFile('leg-verdict-0.json', legOf('auth', 1, 1), 'pass'),
    verdictFile('leg-verdict-1.json', legOf('versions', 1, 2), 'pass'),
    verdictFile('leg-verdict-2.json', legOf('versions', 2, 2), 'pass'),
  ]

  test('every leg passed: nothing to retry', () => {
    const { matrix, plan: result } = plan(all)
    assert.equal(result.planId, '55-2')
    assert.deepEqual(matrix.include, [])
    assert.deepEqual(
      result.legs.map((l) => l.status),
      ['pass', 'pass', 'pass'],
    )
  })

  test('a leg with test failures is planned once, with the matrix fields the retry job needs', () => {
    const files = [...all]
    files[1] = verdictFile('leg-verdict-1.json', legOf('versions', 1, 2), 'test-failures', test1)
    const { matrix, plan: result } = plan(files)
    assert.deepEqual(matrix.include, [
      {
        cacheComponents: false,
        framework: 'next',
        parallel: true,
        retryIndex: 0,
        shard: 1,
        suite: 'versions',
        'total-shards': 2,
      },
    ])
    assert.equal(result.retry[0].key, 'versions|next|1|2|false')
    assert.deepEqual(result.retry[0].tests, test1)
    assert.deepEqual(
      result.legs[1].failed.map((t) => t.title),
      ['a'],
    )
  })

  test('an infra leg is never planned for retry', () => {
    const files = [...all]
    files[0] = verdictFile('leg-verdict-0.json', legOf('auth', 1, 1), 'infra')
    const { matrix, plan: result } = plan(files)
    assert.deepEqual(matrix.include, [])
    assert.equal(result.legs[0].status, 'infra')
  })

  test('a missing verdict, a duplicate and a leg outside the matrix are all recorded', () => {
    const files = [
      all[0],
      { ...all[0], name: 'leg-verdict-9.json' },
      verdictFile('leg-verdict-5.json', legOf('ghost', 1, 1), 'pass'),
    ]
    const { plan: result } = plan(files)
    assert.deepEqual(
      result.legs.map((l) => l.status),
      ['duplicate', 'missing', 'missing'],
    )
    assert.match(result.unexpected.join('\n'), /ghost\|next\|1\|1\|false is not in the matrix/)
  })

  test('a verdict of another kind, schema or verdict value is not trusted', () => {
    const good = JSON.parse(all[0].text)
    for (const over of [{ kind: 'retry' }, { schema: 2 }, { verdict: 'green' }, { leg: null }]) {
      const text = JSON.stringify({ ...good, ...over })
      const { plan: result } = plan([{ name: 'leg-verdict-0.json', text }, all[1], all[2]])
      assert.equal(result.legs[0].status, 'missing', JSON.stringify(over))
      assert.equal(result.unexpected.length, 1, JSON.stringify(over))
    }
  })

  test('an unreadable or unusable verdict is recorded and its leg stays missing', () => {
    const files = [
      { name: 'leg-verdict-0.json', text: '{not json' },
      verdictFile('leg-verdict-1.json', legOf('versions', 1, 2), 'test-failures', []),
      all[2],
    ]
    const { plan: result } = plan(files)
    assert.equal(result.unexpected.length, 2)
    assert.deepEqual(
      result.legs.map((l) => l.status),
      ['missing', 'missing', 'pass'],
    )
  })

  test('an unusable matrix throws instead of planning nothing', () => {
    assert.throws(() =>
      buildPlan({ matrixText: '', runAttempt: '1', runId: '1', verdictFiles: [] }),
    )
  })

  test('select-retry returns exactly the planned tests as regexes', () => {
    const files = [...all]
    files[0] = verdictFile('leg-verdict-0.json', legOf('auth', 1, 1), 'test-failures', test1)
    const { plan: result } = plan(files)
    assert.deepEqual(retrySelection(result, 0), { grep: test1.map((t) => t.grep) })
    assert.throws(() => retrySelection(result, 3), /no tests for index 3/)
  })
})

describe('command line', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        E2E_SHARD: '1',
        E2E_TOTAL_SHARDS: '1',
        GITHUB_OUTPUT: '',
        PAYLOAD_FRAMEWORK: 'next',
        SUITE_NAME: 'auth',
        ...env,
      },
    })

  test('verdict: pass and test-failures exit 0 and write the file; infra exits 1', () => {
    const cases = [
      [0, reportOf([passing('a')]), 0, 'pass'],
      [1, reportOf([failing('a')]), 0, 'test-failures'],
      [1, reportOf([passing('a')]), 1, 'infra'],
    ]
    for (const [exitCode, report, expectedExit, verdict] of cases) {
      const folder = freshDir()
      writeReport(folder, report)
      const out = path.join(folder, 'verdict.json')
      const result = run([
        'verdict',
        '--kind',
        'first',
        '--exit-code',
        String(exitCode),
        '--dir',
        folder,
        '--out',
        out,
      ])
      assert.equal(result.status, expectedExit, result.stdout)
      assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, verdict)
    }
  })

  test('verdict: a missing report exits 1 and still writes an infra verdict', () => {
    const folder = freshDir()
    const out = path.join(folder, 'verdict.json')
    const result = run([
      'verdict',
      '--kind',
      'first',
      '--exit-code',
      '0',
      '--dir',
      folder,
      '--out',
      out,
    ])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /::error title=E2E leg::/)
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, 'infra')
  })

  test('plan then select-retry then retry verdict: the retried test passes and is reported as flaky', () => {
    const matrix = JSON.stringify({
      include: [
        {
          cacheComponents: false,
          framework: 'next',
          parallel: false,
          shard: 1,
          suite: 'auth',
          'total-shards': 1,
        },
      ],
    })
    const first = freshDir()
    writeReport(first, reportOf([failing('a', { line: 5 }), passing('b')]))
    run([
      'verdict',
      '--kind',
      'first',
      '--exit-code',
      '1',
      '--dir',
      first,
      '--out',
      path.join(first, 'leg-verdict-0.json'),
    ])
    const output = path.join(first, 'github-output')
    const planPath = path.join(first, 'gate-e2e-plan.json')
    const planned = run(['plan', '--verdicts', first, '--out', planPath], {
      E2E_MATRIX: matrix,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '42',
    })
    assert.equal(planned.status, 0, planned.stderr)
    const outputs = readFileSync(output, 'utf8')
    assert.match(outputs, /^matrix=\{"include":\[\{.*"retryIndex":0.*\}\]\}$/m)
    assert.match(outputs, /^count=1$/m)

    const selection = path.join(first, 'selection.json')
    assert.equal(
      run(['select-retry', '--plan', planPath, '--index', '0', '--out', selection]).status,
      0,
    )
    const { grep } = JSON.parse(readFileSync(selection, 'utf8'))
    assert.equal(grep.length, 1)
    assert.ok(new RegExp(grep[0]).test('chromium auth/e2e.spec.ts a'))

    const retryDir = freshDir()
    writeReport(retryDir, reportOf([passing('a', { line: 5 })]), 'results_retry_auth_next_1.json')
    const out = path.join(retryDir, 'gate-e2e-retry-0.json')
    const flakyOut = path.join(retryDir, 'flaky-e2e-retry-0.json')
    const result = run([
      'verdict',
      '--kind',
      'retry',
      '--exit-code',
      '0',
      '--dir',
      retryDir,
      '--out',
      out,
      '--plan',
      planPath,
      '--retry-index',
      '0',
      '--flaky-out',
      flakyOut,
    ])
    assert.equal(result.status, 0, result.stdout)
    const verdict = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(verdict.planId, '42-1')
    assert.equal(verdict.verdict, 'pass')
    const flaky = JSON.parse(readFileSync(flakyOut, 'utf8'))
    assert.equal(flaky.flaky[0].via, 'fresh-runner retry')
    assert.equal(flaky.flaky[0].file, 'test/auth/e2e.spec.ts')
  })

  test('retry verdict: a test that fails again exits 1', () => {
    const first = freshDir()
    writeReport(first, reportOf([failing('a')]))
    const verdictPath = path.join(first, 'leg-verdict-0.json')
    run(['verdict', '--kind', 'first', '--exit-code', '1', '--dir', first, '--out', verdictPath])
    const matrix = JSON.stringify({
      include: [
        {
          cacheComponents: false,
          framework: 'next',
          parallel: false,
          shard: 1,
          suite: 'auth',
          'total-shards': 1,
        },
      ],
    })
    const planPath = path.join(first, 'gate-e2e-plan.json')
    run(['plan', '--verdicts', first, '--out', planPath], {
      E2E_MATRIX: matrix,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '1',
    })
    const retryDir = freshDir()
    writeReport(retryDir, reportOf([failing('a')]), 'results_retry.json')
    const result = run([
      'verdict',
      '--kind',
      'retry',
      '--exit-code',
      '1',
      '--dir',
      retryDir,
      '--out',
      path.join(retryDir, 'out.json'),
      '--plan',
      planPath,
      '--retry-index',
      '0',
    ])
    assert.equal(result.status, 1)
    assert.equal(
      JSON.parse(readFileSync(path.join(retryDir, 'out.json'), 'utf8')).verdict,
      'test-failures',
    )
  })

  test('plan: no verdict artifact downloaded at all marks every leg missing instead of crashing', () => {
    const folder = freshDir()
    const matrix = JSON.stringify({
      include: [
        {
          cacheComponents: false,
          framework: 'next',
          parallel: false,
          shard: 1,
          suite: 'auth',
          'total-shards': 1,
        },
      ],
    })
    const out = path.join(folder, 'gate-e2e-plan.json')
    const result = run(['plan', '--verdicts', path.join(folder, 'never-created'), '--out', out], {
      E2E_MATRIX: matrix,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '7',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      JSON.parse(readFileSync(out, 'utf8')).legs.map((leg) => leg.status),
      ['missing'],
    )
  })

  test('readReports ignores other files and reports unreadable ones', () => {
    const folder = freshDir()
    writeFileSync(path.join(folder, 'other.json'), '{}')
    writeFileSync(path.join(folder, 'results_bad.json'), '{broken')
    writeReport(folder, reportOf([passing('a')]), 'results_ok.json')
    const result = readReports(folder)
    assert.deepEqual(result.names, ['results_bad.json', 'results_ok.json'])
    assert.equal(result.reports.length, 1)
    assert.match(result.problems[0], /results_bad\.json: not valid JSON/)
  })
})

describe('wiring in main.yml', () => {
  const text = readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8').replace(
    /\r\n/g,
    '\n',
  )
  const jobs = parseJobs(text)
  const body = (name) => jobs.get(name).lines.join('\n').replace(/\r/g, '')
  const stepsOf = (name) =>
    body(name)
      .split(/\n(?= {6}- )/)
      .slice(1)
  const stepNamed = (job, title) => {
    const step = stepsOf(job).find((s) => s.startsWith(`      - name: ${title}\n`))
    assert.ok(step, `${job} has a step named "${title}"`)
    return step
  }
  const uploads = (job, artifact) =>
    stepsOf(job).filter(
      (s) => s.includes('uses: actions/upload-artifact@') && s.includes(`name: ${artifact}\n`),
    )

  test('no new continue-on-error: only the three that predate the flaky policy remain', () => {
    const found = text.match(/^\s*continue-on-error:.*$/gm).map((line) => line.trim())
    assert.deepEqual(found, [
      'continue-on-error: ${{ matrix.optional }}',
      'continue-on-error: true',
      'continue-on-error: true',
    ])
  })

  test('no test command is masked with || true', () => {
    for (const line of text.split('\n')) {
      if (/pnpm test|playwright|e2e-leg|quarantine\.mjs/.test(line)) {
        assert.doesNotMatch(line, /\|\|\s*true/, line)
      }
    }
  })

  for (const [job, title, kind] of [
    ['tests-e2e', 'E2E Tests', 'first'],
    ['tests-e2e-retry', 'E2E Tests (failed tests only)', 'retry'],
    ['tests-quarantine', 'E2E Tests (quarantined only)', 'quarantine'],
  ]) {
    test(`${job}: the test step hands its exit code to the verdict script and nothing else`, () => {
      const step = stepNamed(job, title)
      const lines = step
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
      const at = lines.indexOf('set +e')
      assert.ok(at > 0 && lines[at - 1] === 'run: |', 'set +e is the first line of the script')
      assert.match(lines[at + 1], /pnpm test:e2e:prod:server:run:noturbo/)
      assert.equal(lines[at + 2], 'code=$?')
      assert.equal(lines[at + 3], 'set -e')
      assert.match(
        lines[at + 4],
        new RegExp(
          `^node \\.github/scripts/e2e-leg\\.mjs verdict --kind ${kind} --exit-code "\\$code" `,
        ),
      )
      assert.match(lines[at + 5], /^env:$/, 'the verdict is the last command of the script')
      assert.match(step, /\n {8}shell: bash\n/)
    })
  }

  for (const [job, artifact, glob] of [
    ['tests-e2e', 'leg-verdict-${{ strategy.job-index }}', 'leg-verdict-{0}.json'],
    ['tests-e2e-retry', 'gate-e2e-retry-${{ strategy.job-index }}', 'gate-e2e-retry-{0}.json'],
    [
      'tests-quarantine',
      'quarantine-result-${{ strategy.job-index }}',
      'quarantine-result-{0}.json',
    ],
  ]) {
    test(`${job}: uploads ${artifact} even when the leg failed, and fails if the file is gone`, () => {
      const [step, ...rest] = uploads(job, artifact)
      assert.ok(step && !rest.length, 'exactly one upload step')
      assert.match(
        step,
        new RegExp(
          `if: \\$\\{\\{ always\\(\\) && hashFiles\\(format\\('${glob.replace(/[{}.]/g, '\\$&')}'`,
        ),
      )
      assert.match(step, /if-no-files-found: error/)
      assert.match(step, /overwrite: true/)
    })
  }

  test('the plan job needs the matrix and every leg, and runs whenever legs ran', () => {
    assert.deepEqual([...jobs.get('e2e-retry-plan').needs].sort(), ['e2e-matrix', 'tests-e2e'])
    assert.match(
      body('e2e-retry-plan'),
      /if: \$\{\{ !cancelled\(\) && needs\.e2e-matrix\.result == 'success' && needs\.tests-e2e\.result != 'skipped' \}\}/,
    )
    assert.match(body('e2e-retry-plan'), /pattern: leg-verdict-\*/)
  })

  test('the retry job needs the prep artifact and the plan, and only runs for a non-empty plan', () => {
    assert.deepEqual([...jobs.get('tests-e2e-retry').needs].sort(), ['e2e-prep', 'e2e-retry-plan'])
    assert.match(
      body('tests-e2e-retry'),
      /if: \$\{\{ !cancelled\(\) && needs\.e2e-prep\.result == 'success' && needs\.e2e-retry-plan\.result == 'success' && needs\.e2e-retry-plan\.outputs\.count != '0' \}\}/,
    )
    assert.doesNotMatch(body('tests-e2e-retry'), /--shard/)
    assert.doesNotMatch(body('tests-e2e-retry'), /--retries/, 'in-job retry counts are not changed')
  })

  test('the retry and quarantine legs set up like a first-run leg', () => {
    const setup = (name) =>
      stepsOf(name)
        .filter((step) =>
          /^ {6}- (?:name: (?:Node setup|Download prepared test environment|Extract prepared test environment|Start services|Setup Playwright)\n|uses: actions\/checkout@)/.test(
            step,
          ),
        )
        .map((step) => step.replace(/\n\s*echo "::error::[^\n]*/g, '').trim())
    for (const job of ['tests-e2e-retry', 'tests-quarantine']) {
      assert.deepEqual(setup(job), setup('tests-e2e'), job)
    }
  })

  test('the first-run legs exclude the quarantined tests that the quarantine legs run', () => {
    assert.deepEqual([...jobs.get('tests-quarantine').needs].sort(), ['e2e-matrix', 'e2e-prep'])
    assert.match(stepsOf('tests-quarantine').join('\n'), /quarantine\.mjs select --mode only/)
    assert.match(stepsOf('tests-e2e').join('\n'), /quarantine\.mjs select --mode exclude/)
    assert.match(
      body('tests-quarantine'),
      /if: \$\{\{ needs\.e2e-matrix\.outputs\.quarantine_count != '0' \}\}/,
    )
  })

  test('the gate downloads the plan and the retry results, not the per-leg verdicts', () => {
    const gate = body('all-green').replace(/^\s*#.*$/gm, '')
    assert.match(gate, /pattern: gate-e2e-\*/)
    assert.match(gate, /if: needs\.changes\.outputs\.needs_tests == 'true'/)
    assert.match(gate, /GATE_E2E_DIR: gate-in/)
    assert.doesNotMatch(gate, /leg-verdict/)
  })

  test('the pipeline checks lint the quarantine list', () => {
    assert.match(body('pipeline-checks'), /run: node \.github\/scripts\/quarantine\.mjs lint/)
  })

  test('the flaky report lists the quarantine results whenever the quarantine job ran', () => {
    const step = stepNamed('flaky-report', 'List the quarantined tests of this run')
    assert.match(step, /if: needs\.tests-quarantine\.result != 'skipped'/)
    assert.match(step, /quarantine\.mjs report --dir quarantine-results/)
  })
})
