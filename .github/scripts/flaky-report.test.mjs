import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { aggregate, extract, jobSummary, playwrightFlaky, runSummary } from './flaky-report.mjs'
import { parseJobs } from './lib/workflow.mjs'
import FlakyReporter from './vitest-flaky-reporter.mjs'

const script = path.join(import.meta.dirname, 'flaky-report.mjs')
const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flaky-'))
})
afterEach(() => {
  rmSync(dir, { force: true, recursive: true })
})

const attempt = (retry, status, message) => ({
  retry,
  status,
  ...(message ? { error: { message }, errors: [{ message }] } : {}),
})

// Shape of a Playwright 1.63.0 JSON report: file suite > describe suites > specs > tests > results.
const playwrightReport = () => ({
  stats: { expected: 1, flaky: 2, skipped: 1, unexpected: 1 },
  suites: [
    {
      file: 'auth/e2e.spec.ts',
      suites: [
        {
          file: 'auth/e2e.spec.ts',
          specs: [
            {
              file: 'auth/e2e.spec.ts',
              line: 6,
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    attempt(0, 'failed', '\u001b[31mError:\u001b[39m first attempt\n  at x'),
                    attempt(1, 'failed', 'second'),
                    attempt(2, 'passed'),
                  ],
                  status: 'flaky',
                },
              ],
              title: 'should have up-to-date user info',
            },
            {
              file: 'auth/e2e.spec.ts',
              line: 7,
              tests: [
                { projectName: 'chromium', results: [attempt(0, 'passed')], status: 'expected' },
              ],
              title: 'steady',
            },
            {
              file: 'auth/e2e.spec.ts',
              line: 8,
              tests: [
                {
                  projectName: 'chromium',
                  results: [attempt(0, 'failed', 'a'), attempt(1, 'failed', 'a')],
                  status: 'unexpected',
                },
              ],
              title: 'really broken',
            },
            {
              file: 'auth/e2e.spec.ts',
              line: 9,
              tests: [{ projectName: 'chromium', results: [], status: 'skipped' }],
              title: 'skipped',
            },
          ],
          suites: [
            {
              file: 'auth/e2e.spec.ts',
              specs: [
                {
                  file: 'auth/e2e.spec.ts',
                  line: 4,
                  tests: [
                    {
                      projectName: 'chromium',
                      results: [attempt(0, 'timedOut', 'Test timeout'), attempt(1, 'passed')],
                      status: 'flaky',
                    },
                  ],
                  title: 'nested',
                },
              ],
              title: 'authenticated users',
            },
          ],
          title: 'Auth',
        },
      ],
      title: 'auth/e2e.spec.ts',
    },
  ],
})

describe('Playwright reports', () => {
  test('lists only tests whose status is flaky, with retries and first error', () => {
    const flaky = playwrightFlaky(playwrightReport(), { framework: 'next', prefix: 'test' })
    assert.deepEqual(flaky, [
      {
        error: 'Error: first attempt',
        file: 'test/auth/e2e.spec.ts',
        framework: 'next',
        line: 6,
        project: 'chromium',
        retries: 2,
        title: 'Auth > should have up-to-date user info',
      },
      {
        error: 'Test timeout',
        file: 'test/auth/e2e.spec.ts',
        framework: 'next',
        line: 4,
        project: 'chromium',
        retries: 1,
        title: 'Auth > authenticated users > nested',
      },
    ])
  })

  test('a report without flaky tests yields nothing', () => {
    const report = { stats: { expected: 1 }, suites: [] }
    assert.deepEqual(playwrightFlaky(report), [])
  })
})

describe('extract', () => {
  test('reads results_*.json, ignores other json files, and counts executed tests', () => {
    writeFileSync(path.join(dir, 'results_auth_next_1.json'), JSON.stringify(playwrightReport()))
    writeFileSync(path.join(dir, 'package.json'), '{"suites": [{"specs": []}]}')
    const result = extract({ framework: 'next', job: 'E2E - auth', playwrightDir: dir })
    assert.equal(result.flaky.length, 2)
    assert.equal(result.stats.executed, 4)
    assert.equal(result.stats.playwrightFiles, 1)
    assert.deepEqual(result.notes, [])
  })

  test('a missing report is a note, not an error', () => {
    const result = extract({ job: 'E2E - auth', playwrightDir: path.join(dir, 'absent') })
    assert.deepEqual(result.flaky, [])
    assert.match(result.notes[0], /no Playwright JSON report found/)
  })

  test('an unreadable report is a note and the others are still read', () => {
    writeFileSync(path.join(dir, 'results_a.json'), '{not json')
    writeFileSync(path.join(dir, 'results_b.json'), JSON.stringify(playwrightReport()))
    const result = extract({ job: 'j', playwrightDir: dir })
    assert.equal(result.flaky.length, 2)
    assert.match(result.notes.join('\n'), /could not read results_a\.json/)
  })

  test('reads the vitest reporter output', () => {
    const flaky = [
      { file: 'test/queues/int.spec.ts', project: 'int', retries: 1, title: 'cron > recover' },
    ]
    writeFileSync(
      path.join(dir, 'vitest-flaky-1.json'),
      JSON.stringify({ executed: 40, flaky, kind: 'vitest' }),
    )
    const result = extract({ job: 'int-postgres (1/3)', vitestDir: dir })
    assert.deepEqual(result.flaky, [{ ...flaky[0], framework: '' }])
    assert.equal(result.stats.executed, 40)
  })
})

describe('aggregate', () => {
  const sighting = (retries, extra = {}) => ({
    error: '',
    file: 'test/versions/e2e.spec.ts',
    framework: 'next',
    line: 565,
    retries,
    title: 'versions > autosave',
    ...extra,
  })

  test('one entry per test across jobs, counted and sorted by frequency', () => {
    const report = aggregate([
      {
        flaky: [sighting(1), sighting(2, { line: 9, title: 'other' })],
        job: 'E2E - versions (1/3)',
        stats: { executed: 10 },
      },
      { flaky: [sighting(3)], job: 'E2E - versions (2/3)', stats: { executed: 20 } },
      { flaky: [], job: 'E2E - empty', stats: { executed: 5 } },
    ])
    assert.equal(report.distinctTests, 2)
    assert.equal(report.occurrences, 3)
    assert.equal(report.jobsReporting, 3)
    assert.equal(report.jobsWithFlaky, 2)
    assert.equal(report.executed, 35)
    assert.equal(report.tests[0].title, 'versions > autosave')
    assert.equal(report.tests[0].maxRetries, 3)
    assert.deepEqual(
      report.tests[0].sightings.map((s) => s.job),
      ['E2E - versions (1/3)', 'E2E - versions (2/3)'],
    )
  })

  test('the same test under two frameworks stays two entries', () => {
    const report = aggregate([
      { flaky: [sighting(1), sighting(1, { framework: 'tanstack-start' })], job: 'j', stats: {} },
    ])
    assert.equal(report.distinctTests, 2)
  })

  test('a test rescued by the fresh-runner retry says so, next to an in-job retry of the same test', () => {
    const report = aggregate([
      { flaky: [sighting(1)], job: 'E2E - versions (1/3)', stats: {} },
      {
        flaky: [sighting(2, { via: 'fresh-runner retry' })],
        job: 'E2E retry - versions',
        stats: {},
      },
    ])
    assert.equal(report.distinctTests, 1)
    assert.deepEqual(
      report.tests[0].sightings.map((s) => s.via),
      ['in-job retry', 'fresh-runner retry'],
    )
    assert.match(runSummary(report), /\| next \| 2 \| 2 \| in-job retry, fresh-runner retry \|/)
  })

  test('summaries name the test and escape table pipes', () => {
    const report = aggregate([{ flaky: [sighting(1, { title: 'a | b' })], job: 'j', stats: {} }])
    assert.match(runSummary(report), /test\/versions\/e2e\.spec\.ts:565 a \\\| b \| next \| 1 \| 1/)
    assert.match(
      jobSummary({ flaky: report.tests.map((t) => ({ ...t, retries: 1 })), job: 'j' }),
      /Flaky tests in j: 1/,
    )
  })
})

describe('command line', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
    })

  test('extract writes the job file and a step summary when something is flaky', () => {
    writeFileSync(path.join(dir, 'results_auth_next_1.json'), JSON.stringify(playwrightReport()))
    const out = path.join(dir, 'flaky-e2e-0.json')
    const summary = path.join(dir, 'summary.md')
    const result = run(['extract', '--playwright-dir', dir, '--out', out], {
      FLAKY_JOB: 'E2E - auth [next]',
      GITHUB_STEP_SUMMARY: summary,
      PAYLOAD_FRAMEWORK: 'next',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).flaky.length, 2)
    assert.match(readFileSync(summary, 'utf8'), /Flaky tests in E2E - auth \[next\]: 2/)
  })

  test('extract writes no file when nothing is flaky, unless asked', () => {
    writeFileSync(
      path.join(dir, 'results_a.json'),
      JSON.stringify({ stats: { expected: 3 }, suites: [] }),
    )
    const out = path.join(dir, 'out.json')
    assert.equal(run(['extract', '--playwright-dir', dir, '--out', out]).status, 0)
    assert.equal(existsSync(out), false)
    assert.equal(
      run(['extract', '--playwright-dir', dir, '--out', out, '--always-write']).status,
      0,
    )
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).stats.executed, 3)
  })

  test('extract never fails the job when the report is missing; it warns', () => {
    const result = run([
      'extract',
      '--playwright-dir',
      path.join(dir, 'absent'),
      '--out',
      path.join(dir, 'o.json'),
    ])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /::warning title=Flaky report::.*no Playwright JSON report found/)
  })

  test('aggregate merges the per-job files', () => {
    const inputs = path.join(dir, 'inputs')
    mkdirSync(inputs)
    const flaky = [{ file: 'f.ts', framework: '', line: 0, retries: 1, title: 't' }]
    writeFileSync(path.join(inputs, 'flaky-a.json'), JSON.stringify({ flaky, job: 'a', stats: {} }))
    writeFileSync(path.join(inputs, 'flaky-b.json'), JSON.stringify({ flaky, job: 'b', stats: {} }))
    const out = path.join(dir, 'flaky-report.json')
    assert.equal(run(['aggregate', '--dir', inputs, '--out', out]).status, 0)
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(report.distinctTests, 1)
    assert.equal(report.tests[0].sightings.length, 2)
  })
})

describe('vitest reporter', () => {
  const testCase = (title, flaky, retryCount) => ({
    diagnostic: () => ({ flaky, retryCount }),
    fullName: title,
    project: { name: 'int' },
  })
  const modulesIn = (root) => [
    {
      children: {
        allTests: () => [testCase('suite > steady', false, 0), testCase('suite > shaky', true, 2)],
      },
      moduleId: path.join(root, 'test', 'queues', 'int.spec.ts'),
    },
  ]

  test('writes only retried-then-passed tests, repo-relative, when VITEST_FLAKY_DIR is set', () => {
    const reporter = new FlakyReporter()
    reporter.onInit({ config: { root: dir } })
    process.env.VITEST_FLAKY_DIR = path.join(dir, 'out')
    try {
      reporter.onTestRunEnd(modulesIn(dir))
    } finally {
      delete process.env.VITEST_FLAKY_DIR
    }
    const [file] = extract({ job: 'j', vitestDir: path.join(dir, 'out') }).flaky
    assert.deepEqual(file, {
      file: 'test/queues/int.spec.ts',
      framework: '',
      project: 'int',
      retries: 2,
      title: 'suite > shaky',
    })
  })

  test('does nothing when VITEST_FLAKY_DIR is unset', () => {
    delete process.env.VITEST_FLAKY_DIR
    const reporter = new FlakyReporter()
    reporter.onInit({ config: { root: dir } })
    reporter.onTestRunEnd(modulesIn(dir))
    assert.equal(existsSync(path.join(dir, 'out')), false)
  })
})

describe('wiring in main.yml and vitest.config.ts', () => {
  const jobs = parseJobs(readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8'))

  for (const name of ['tests-unit', 'tests-int', 'tests-e2e', 'visual-regression']) {
    test(`${name} lists its flaky tests even when the tests failed`, () => {
      const text = jobs.get(name).lines.join('\n')
      const step =
        /- name: List flaky tests\n\s+if: always\(\)\n\s+run: node \.github\/scripts\/flaky-report\.mjs extract/
      assert.match(text, step)
    })
  }

  test('flaky-report runs after the test jobs and is not part of the gate', () => {
    const job = jobs.get('flaky-report')
    assert.deepEqual([...job.needs].sort(), [
      'tests-e2e',
      'tests-int',
      'tests-unit',
      'visual-regression',
    ])
    assert.equal(jobs.get('all-green').needs.includes('flaky-report'), false)
  })

  test('the vitest config loads the reporter that exists in the repo', () => {
    const config = readFileSync(path.join(root, 'vitest.config.ts'), 'utf8')
    assert.match(config, /\.github\/scripts\/vitest-flaky-reporter\.mjs/)
    assert.equal(existsSync(path.join(root, '.github/scripts/vitest-flaky-reporter.mjs')), true)
  })
})
