// Reads Playwright JSON reports and decides whether a leg failed at test level (retryable) or not.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const firstLine = (text) =>
  (text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 240) ?? ''

export const testKey = (file, title) => `${file}\u0000${title}`

export function parseReport(text) {
  let report
  try {
    report = JSON.parse(text)
  } catch (error) {
    throw new Error(`not valid JSON: ${error.message}`)
  }
  const stats = report?.stats
  const valid =
    Array.isArray(report?.suites) &&
    Array.isArray(report?.errors) &&
    ['expected', 'unexpected', 'flaky', 'skipped'].every((name) => Number.isInteger(stats?.[name]))
  if (!valid) {
    throw new Error('not a Playwright JSON report (suites, errors or stats missing)')
  }
  return report
}

/** Every `results_*.json` in a directory: parsed reports plus a reason for each unreadable one. */
export function readReports(directory) {
  const names = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => /^results_.*\.json$/.test(name))
        .sort()
    : []
  const reports = []
  const problems = []
  for (const name of names) {
    try {
      reports.push({ name, report: parseReport(readFileSync(path.join(directory, name), 'utf8')) })
    } catch (error) {
      problems.push(`${name}: ${error.message}`)
    }
  }
  return { names, problems, reports }
}

/**
 * Flattens a report into tests. `file` is the file-level suite (the spec that was loaded), not the
 * wrapper in test/__helpers that a helper-defined test reports as its own location.
 */
export function collectTests(report, { prefix = '' } = {}) {
  const tests = []
  for (const fileSuite of report.suites) {
    const fileTitle = String(fileSuite.title ?? '').replace(/\\/g, '/')
    const file = prefix ? `${prefix}/${fileSuite.file}` : fileSuite.file
    const visit = (suite, titles) => {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const results = test.results ?? []
          const failedResult = [...results].reverse().find((r) => r.status !== 'passed')
          const titlePath = [...titles, spec.title]
          tests.push({
            attempts: results.length,
            error: firstLine(failedResult?.error?.message ?? failedResult?.errors?.[0]?.message),
            expected: test.expectedStatus,
            file,
            fileTitle,
            line: spec.line,
            where:
              spec.file === fileSuite.file
                ? `${file}:${spec.line}`
                : `${file} (defined at ${prefix ? `${prefix}/` : ''}${spec.file}:${spec.line})`,
            project: test.projectName,
            results: results.map((result) => result.status),
            status: test.status,
            title: titlePath.join(' > '),
            titlePath,
          })
        }
      }
      for (const child of suite.suites ?? []) {
        visit(child, child.title ? [...titles, child.title] : titles)
      }
    }
    visit(fileSuite, [])
  }
  return tests
}

/** Matches the string Playwright greps: project, file path under the config dir, titles, tags. */
export function titleRegexSource({ fileTitle, titlePath }) {
  const file = fileTitle.split('/').map(escapeRegExp).join('[\\\\/]')
  return `^\\S+ ${file} ${titlePath.map(escapeRegExp).join(' ')}(?: @\\S+)*$`
}

const describeTest = (test) => ({
  attempts: test.attempts,
  error: test.error,
  file: test.file,
  grep: titleRegexSource(test),
  line: test.line,
  project: test.project,
  title: test.title,
  titlePath: test.titlePath,
  where: test.where,
})

const FAILED = new Set(['failed', 'timedOut'])
const WORKER_CRASH = /worker process exited unexpectedly/

/**
 * `verdict`: 'pass' (exit 0, nothing failed), 'test-failures' (every failure is a failed test that
 * ran to completion), or 'infra' (anything else: no report, global errors, tests that did not
 * run, interrupted tests, an exit code the report does not explain).
 */
export function classify({ exitCode, report, prefix = 'test' }) {
  if (!Number.isInteger(exitCode)) {
    return { failed: [], reason: `exit code "${exitCode}" is not a number`, verdict: 'infra' }
  }
  if (report.errors.length) {
    const message = firstLine(report.errors[0].message ?? JSON.stringify(report.errors[0]))
    return { failed: [], reason: `Playwright reported an error: ${message}`, verdict: 'infra' }
  }
  const tests = collectTests(report, { prefix })
  const stats = {
    executed: report.stats.expected + report.stats.unexpected + report.stats.flaky,
    flaky: report.stats.flaky,
    skipped: report.stats.skipped,
    unexpected: report.stats.unexpected,
  }
  const infra = (reason) => ({ failed: [], reason, stats, tests, verdict: 'infra' })

  const interrupted = tests.filter((test) => test.results.includes('interrupted'))
  if (interrupted.length) {
    return infra(`${interrupted.length} tests were interrupted (first: ${interrupted[0].title})`)
  }
  const didNotRun = tests.filter((test) => test.status === 'skipped' && test.expected !== 'skipped')
  if (didNotRun.length) {
    return infra(`${didNotRun.length} tests did not run (first: ${didNotRun[0].title})`)
  }
  const unexpected = tests.filter((test) => test.status === 'unexpected')
  if (unexpected.length !== report.stats.unexpected) {
    return infra(
      `report is inconsistent: stats.unexpected is ${report.stats.unexpected} but ${unexpected.length} tests are unexpected`,
    )
  }
  if (exitCode === 0) {
    return unexpected.length
      ? infra(`exit code 0 but ${unexpected.length} failed tests in the report`)
      : { failed: [], reason: '', stats, tests, verdict: 'pass' }
  }
  if (!unexpected.length) {
    return infra(`exit code ${exitCode} without a failed test (setup, crash, timeout or exit)`)
  }
  const notTestLevel = unexpected.filter((test) => !FAILED.has(test.results.at(-1)))
  if (notTestLevel.length) {
    return infra(`${notTestLevel.length} unexpected tests did not end failed or timedOut`)
  }
  const crashed = unexpected.filter((test) => WORKER_CRASH.test(test.error))
  if (crashed.length) {
    return infra(`${crashed.length} tests lost their worker process (first: ${crashed[0].title})`)
  }
  return {
    failed: unexpected.map(describeTest),
    reason: `${unexpected.length} failed tests`,
    stats,
    tests,
    verdict: 'test-failures',
  }
}

export const legKey = (leg) =>
  [leg.suite, leg.framework, leg.shard, leg.totalShards, Boolean(leg.cacheComponents)].join('|')

export const matrixLegs = (matrixText) => {
  const matrix = JSON.parse(matrixText)
  if (!Array.isArray(matrix?.include) || !matrix.include.length) {
    throw new Error('e2e matrix has no include entries')
  }
  return matrix.include.map((entry) => ({
    cacheComponents: Boolean(entry.cacheComponents),
    framework: entry.framework,
    optional: entry.optional === true,
    parallel: entry.parallel !== false,
    shard: Number(entry.shard),
    suite: entry.suite,
    totalShards: Number(entry['total-shards']),
  }))
}
