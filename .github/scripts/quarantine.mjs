#!/usr/bin/env node
// Quarantine list (.github/test-quarantine.json): lint, per-leg test selection, matrix, run report.
//   lint    fails on a malformed or expired entry
//   select  writes the Playwright selection file for one leg (exclude from gating, or only these)
//   matrix  one quarantine leg per framework and suite, from the E2E matrix
//   report  summarises the quarantine legs of a run; failures are listed first

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { matrixLegs, testKey, titleRegexSource } from './lib/e2e-report.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const DEFAULT_FILE = path.join(root, '.github/test-quarantine.json')
export const FRAMEWORKS = ['next', 'tanstack-start']
export const LIFETIME_DAYS = 30
export const MIN_FLAKY_RATE = 0.25

const DATE = /^\d{4}-\d{2}-\d{2}$/
const day = (text) => (DATE.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN)
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

export function readQuarantine(file = DEFAULT_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (data?.schema !== 1 || !Array.isArray(data.entries)) {
    throw new Error(`${file}: expected { "schema": 1, "entries": [...] }`)
  }
  return data.entries
}

export const entryKey = (entry) => testKey(entry.file, entry.titlePath.join(' > '))

export const entryRegexSource = (entry) =>
  titleRegexSource({
    fileTitle: entry.file.replace(/^test\//, ''),
    titlePath: entry.titlePath,
  })

/** Problems with the list; `now` is an ISO day, `specText(file)` returns the spec source or null. */
export function lint(entries, { now, specText }) {
  const errors = []
  const today = day(now)
  const seen = new Set()
  entries.forEach((entry, index) => {
    const name = `entry ${index} (${entry.framework} ${entry.file}:${entry.line} ${entry.titlePath?.join(' > ')})`
    const bad = (message) => errors.push(`${name}: ${message}`)

    if (!FRAMEWORKS.includes(entry.framework)) {
      bad(`framework must be one of ${FRAMEWORKS.join(', ')}`)
    }
    if (!Array.isArray(entry.suites) || !entry.suites.length || entry.suites.some((s) => !s)) {
      bad('suites must list at least one E2E matrix suite')
    }
    if (!/^test\/.+e2e\.spec\.ts$/.test(entry.file ?? '')) {
      bad('file must be a test/**/*e2e.spec.ts path')
    }
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      bad('line must be a positive integer')
    }
    if (
      !Array.isArray(entry.titlePath) ||
      !entry.titlePath.length ||
      entry.titlePath.some((t) => typeof t !== 'string' || !t)
    ) {
      bad('titlePath must be the describe titles followed by the test title')
    } else {
      const key = `${entry.framework}|${entryKey(entry)}`
      if (seen.has(key)) {
        bad('duplicate of an earlier entry')
      }
      seen.add(key)
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      bad('reason is required')
    }

    const evidence = entry.evidence ?? {}
    const { flakyRuns, greenMainRuns, ratePercent } = evidence
    if (!Number.isInteger(flakyRuns) || !Number.isInteger(greenMainRuns) || greenMainRuns < 1) {
      bad('evidence needs integer flakyRuns and greenMainRuns')
    } else {
      if (flakyRuns / greenMainRuns < MIN_FLAKY_RATE) {
        bad(`flaked in ${flakyRuns} of ${greenMainRuns} green runs, below ${MIN_FLAKY_RATE * 100}%`)
      }
      if (ratePercent !== Math.round((flakyRuns * 100) / greenMainRuns)) {
        bad('evidence.ratePercent does not equal flakyRuns / greenMainRuns')
      }
    }
    if (typeof evidence.window !== 'string' || !evidence.window) {
      bad('evidence.window is required')
    }

    const added = day(entry.added)
    const expires = day(entry.expires)
    if (Number.isNaN(added) || Number.isNaN(expires)) {
      bad('added and expires must be YYYY-MM-DD')
    } else {
      if (expires !== added + LIFETIME_DAYS * 86400000) {
        bad(
          `expires must be added + ${LIFETIME_DAYS} days (${isoDay(added + LIFETIME_DAYS * 86400000)})`,
        )
      }
      if (added > today) {
        bad(`added ${entry.added} is in the future`)
      }
      if (expires < today) {
        bad(
          `expired on ${entry.expires}: review it. Delete the entry when the test is stable, or renew it with fresh evidence and a new added date`,
        )
      }
    }

    const source = typeof entry.file === 'string' ? specText(entry.file) : null
    if (source === null) {
      bad(`${entry.file} does not exist`)
    } else if (Array.isArray(entry.titlePath) && entry.titlePath.length) {
      for (const title of entry.titlePath) {
        if (typeof title === 'string' && title && !source.includes(title)) {
          bad(`title "${title}" does not appear in ${entry.file}`)
        }
      }
    }
  })
  return errors
}

const forLeg = (entries, { framework, suite }) =>
  entries.filter((entry) => entry.framework === framework && entry.suites.includes(suite))

/** `exclude` keeps these tests out of the gating legs; `only` is the quarantine leg's selection. */
export function selection(entries, { framework, suite, mode }) {
  const sources = forLeg(entries, { framework, suite }).map(entryRegexSource)
  if (mode !== 'exclude' && mode !== 'only') {
    throw new Error(`mode must be exclude or only, got "${mode}"`)
  }
  if (!sources.length) {
    return {}
  }
  return mode === 'exclude' ? { grepInvert: sources } : { grep: sources }
}

/** One leg per framework and suite that has entries; fails on a suite the E2E matrix lacks. */
export function quarantineMatrix(entries, matrixText) {
  const legs = matrixLegs(matrixText)
  const groups = new Map()
  for (const entry of entries) {
    for (const suite of entry.suites) {
      const found = legs.filter((leg) => leg.suite === suite && leg.framework === entry.framework)
      if (!found.length) {
        throw new Error(
          `quarantine entry ${entry.file}:${entry.line}: no E2E leg for ${entry.framework} ${suite}`,
        )
      }
      const id = `${entry.framework}|${suite}`
      const group = groups.get(id) ?? {
        framework: entry.framework,
        parallel: found[0].parallel,
        suite,
        tests: 0,
      }
      group.tests++
      groups.set(id, group)
    }
  }
  return { include: [...groups.values()] }
}

const OUTCOME_TEXT = {
  failed: 'FAILED ON EVERY ATTEMPT',
  flaky: 'passed after an in-job retry',
  passed: 'passed',
  skipped: 'skipped',
}

/** Markdown for the run summary plus the annotations to print. `results` are quarantine verdicts. */
export function renderReport(entries, results) {
  const rows = []
  for (const entry of entries) {
    for (const suite of entry.suites) {
      const verdict = results.find(
        (r) => r.leg?.framework === entry.framework && r.leg?.suite === suite,
      )
      const found = verdict?.tests?.find((t) => testKey(t.file, t.title) === entryKey(entry))
      rows.push({
        entry,
        outcome: found
          ? (OUTCOME_TEXT[found.outcome] ?? found.outcome)
          : 'NOT RUN (no result for this test)',
        problem: !found || found.outcome === 'failed',
        suite,
      })
    }
  }
  const problems = rows.filter((row) => row.problem)
  const line = (row) =>
    `| ${row.entry.file}:${row.entry.line} ${row.entry.titlePath.join(' > ').replace(/\|/g, '\\|')} | ${row.entry.framework} | ${row.suite} | ${row.outcome} | ${row.entry.expires} |`
  const table = (list) => [
    '| test | framework | suite | outcome | expires |',
    '| --- | --- | --- | --- | --- |',
    ...list.map(line),
  ]
  const lines = [`## Quarantined tests (run every time, never gate): ${entries.length}`, '']
  if (problems.length) {
    lines.push(
      `### ATTENTION: ${problems.length} quarantined test results need a look`,
      '',
      ...table(problems),
      '',
    )
  }
  lines.push('### All quarantined tests', '', ...table(rows), '')
  return {
    annotations: problems.map(
      (row) =>
        `::warning title=Quarantined test::${row.entry.framework} ${row.suite} ${row.entry.file}:${row.entry.line} ${row.entry.titlePath.at(-1)}: ${row.outcome}`,
    ),
    problems: problems.length,
    summary: lines.join('\n'),
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const option = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const need = (name) => {
    const value = option(name)
    if (value === undefined) {
      console.error(`quarantine ${command}: missing ${name}`)
      process.exit(2)
    }
    return value
  }
  const entries = readQuarantine(option('--file') ?? DEFAULT_FILE)

  if (command === 'lint') {
    const errors = lint(entries, {
      now: option('--now') ?? new Date().toISOString().slice(0, 10),
      specText: (file) =>
        existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null,
    })
    for (const error of errors) {
      console.log(`::error title=Test quarantine::${error}`)
    }
    console.log(`test quarantine: ${entries.length} entries, ${errors.length} problems`)
    process.exit(errors.length ? 1 : 0)
  } else if (command === 'select') {
    writeFileSync(
      need('--out'),
      JSON.stringify(
        selection(entries, {
          framework: need('--framework'),
          mode: need('--mode'),
          suite: need('--suite'),
        }),
      ),
    )
  } else if (command === 'matrix') {
    const matrix = quarantineMatrix(entries, process.env.E2E_MATRIX ?? '')
    console.log(`quarantine legs: ${matrix.include.length}`)
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `quarantine_matrix=${JSON.stringify(matrix)}\nquarantine_count=${matrix.include.length}\n`,
      )
    }
  } else if (command === 'report') {
    const directory = need('--dir')
    const results = existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => /^quarantine-result-.*\.json$/.test(name))
          .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
      : []
    const report = renderReport(entries, results)
    console.log(report.summary)
    for (const annotation of report.annotations) {
      console.log(annotation)
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.summary)
    }
  } else {
    console.error('usage: quarantine.mjs lint|select|matrix|report ...')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
