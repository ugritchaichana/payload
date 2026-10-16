#!/usr/bin/env node
// Lists tests that passed only after a retry (extract: one job, aggregate: one run). Never gates.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

const firstLine = (text) =>
  (text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 240) ?? ''

/** Flaky tests of one Playwright JSON report; `prefix` turns config-relative paths repo-relative. */
export function playwrightFlaky(report, { framework = '', prefix = '' } = {}) {
  const flaky = []
  const visit = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'flaky') {
          continue
        }
        const failed = (test.results ?? []).find((result) => result.status !== 'passed')
        flaky.push({
          error: firstLine(failed?.error?.message ?? failed?.errors?.[0]?.message),
          file: prefix ? `${prefix}/${spec.file}` : spec.file,
          framework,
          line: spec.line,
          project: test.projectName,
          retries: (test.results ?? []).length - 1,
          title: [...titles, spec.title].join(' > '),
        })
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, [...titles, child.title])
    }
  }
  for (const fileSuite of report.suites ?? []) {
    visit(fileSuite, [])
  }
  return flaky
}

const listDirectory = (directory, pattern) =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => pattern.test(name))
        .sort()
    : []

export function extract({ job, framework, playwrightDir, vitestDir }) {
  const flaky = []
  const notes = []
  const stats = { executed: 0, playwrightFiles: 0, vitestFiles: 0 }

  if (playwrightDir) {
    const files = listDirectory(playwrightDir, /^results_.*\.json$/)
    stats.playwrightFiles = files.length
    if (!files.length) {
      notes.push(`no Playwright JSON report found in ${playwrightDir}`)
    }
    for (const file of files) {
      try {
        const report = JSON.parse(readFileSync(path.join(playwrightDir, file), 'utf8'))
        const { expected = 0, unexpected = 0, flaky: flakyCount = 0 } = report.stats ?? {}
        stats.executed += expected + unexpected + flakyCount
        flaky.push(...playwrightFlaky(report, { framework, prefix: playwrightDir }))
      } catch (error) {
        notes.push(`could not read ${file}: ${error.message}`)
      }
    }
  }

  if (vitestDir) {
    const files = listDirectory(vitestDir, /^vitest-flaky-.*\.json$/)
    stats.vitestFiles = files.length
    if (!files.length) {
      notes.push(`no vitest flaky report found in ${vitestDir}`)
    }
    for (const file of files) {
      try {
        const report = JSON.parse(readFileSync(path.join(vitestDir, file), 'utf8'))
        stats.executed += report.executed ?? 0
        flaky.push(...report.flaky.map((test) => ({ ...test, framework: '' })))
      } catch (error) {
        notes.push(`could not read ${file}: ${error.message}`)
      }
    }
  }

  return { flaky, job, notes, stats }
}

const cell = (text) => String(text).replace(/\|/g, '\\|')
const where = (test) => `${test.file}${test.line ? `:${test.line}` : ''}`

export function jobSummary({ job, flaky }) {
  return [
    `### Flaky tests in ${job}: ${flaky.length}`,
    '',
    '| test | retries needed | first error |',
    '| --- | --- | --- |',
    ...flaky.map(
      (test) =>
        `| ${cell(where(test))} ${cell(test.title)} | ${test.retries} | ${cell(test.error ?? '')} |`,
    ),
    '',
  ].join('\n')
}

/** Merges per-job results; one entry per test (framework, file, line, title) with every sighting. */
export function aggregate(jobResults) {
  const byTest = new Map()
  let occurrences = 0
  for (const result of jobResults) {
    for (const test of result.flaky) {
      occurrences++
      const key = [test.framework, test.file, test.line ?? 0, test.title].join('\u0000')
      const entry = byTest.get(key) ?? {
        file: test.file,
        framework: test.framework,
        line: test.line ?? 0,
        sightings: [],
        title: test.title,
      }
      entry.sightings.push({ error: test.error ?? '', job: result.job, retries: test.retries })
      byTest.set(key, entry)
    }
  }
  const tests = [...byTest.values()]
    .map((entry) => ({ ...entry, maxRetries: Math.max(...entry.sightings.map((s) => s.retries)) }))
    .sort((a, b) => b.sightings.length - a.sightings.length || a.file.localeCompare(b.file))
  return {
    distinctTests: tests.length,
    executed: jobResults.reduce((sum, result) => sum + (result.stats?.executed ?? 0), 0),
    jobsReporting: jobResults.length,
    jobsWithFlaky: jobResults.filter((result) => result.flaky.length).length,
    occurrences,
    tests,
  }
}

export function runSummary(report, limit = 60) {
  const lines = [
    `## Flaky tests (passed only after a retry): ${report.distinctTests}`,
    '',
    `${report.occurrences} occurrences in ${report.jobsWithFlaky} of ${report.jobsReporting} reporting jobs; ${report.executed} tests executed in those jobs.`,
    '',
    '| test | framework | jobs | max retries |',
    '| --- | --- | --- | --- |',
    ...report.tests
      .slice(0, limit)
      .map(
        (test) =>
          `| ${cell(where(test))} ${cell(test.title)} | ${test.framework || '-'} | ${test.sightings.length} | ${test.maxRetries} |`,
      ),
  ]
  if (report.tests.length > limit) {
    lines.push('', `${report.tests.length - limit} more in flaky-report.json.`)
  }
  return lines.join('\n') + '\n'
}

const appendSummary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const option = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const out = option('--out')

  if (command === 'extract') {
    const result = extract({
      framework: process.env.PAYLOAD_FRAMEWORK ?? '',
      job: process.env.FLAKY_JOB ?? 'unknown job',
      playwrightDir: option('--playwright-dir'),
      vitestDir: option('--vitest-dir'),
    })
    for (const note of result.notes) {
      console.log(`::warning title=Flaky report::${result.job}: ${note}`)
    }
    console.log(`${result.job}: ${result.flaky.length} flaky of ${result.stats.executed} executed`)
    if (result.flaky.length) {
      appendSummary(jobSummary(result))
    }
    if (out && (result.flaky.length || args.includes('--always-write'))) {
      writeFileSync(out, JSON.stringify(result))
    }
  } else if (command === 'aggregate') {
    const directory = option('--dir')
    const results = listDirectory(directory, /\.json$/).map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
    )
    const report = aggregate(results)
    console.log(runSummary(report))
    appendSummary(runSummary(report))
    writeFileSync(out, JSON.stringify(report, null, 2))
  } else {
    console.error('usage: flaky-report.mjs extract|aggregate ...')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
