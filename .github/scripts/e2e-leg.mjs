#!/usr/bin/env node
// E2E leg verdicts and the fresh-runner retry plan.
//   verdict       after a Playwright run: classify the leg and write its verdict file
//   plan          after all legs: read every verdict, write the retry plan and the retry matrix
//   select-retry  in a retry leg: turn the plan entry into a Playwright selection file

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  classify,
  legKey,
  matrixLegs,
  MAX_RETRY_LEGS,
  readReports,
  testKey,
} from './lib/e2e-report.mjs'

const SCHEMA = 1
const VERDICTS = new Set(['pass', 'test-failures', 'infra'])

const outcomeOf = (test) =>
  test.status === 'expected' || test.status === 'flaky'
    ? 'passed'
    : test.status === 'unexpected'
      ? 'failed'
      : 'skipped'

/** Result of one planned test in the retry report; 'not-run' when the report does not list it. */
export function retryOutcomes(planned, tests) {
  const byKey = new Map(tests.map((test) => [testKey(test.file, test.title), test]))
  return planned.map((test) => {
    const found = byKey.get(testKey(test.file, test.title))
    return {
      attempts: found?.attempts ?? 0,
      file: test.file,
      line: test.line,
      outcome: found ? outcomeOf(found) : 'not-run',
      title: test.title,
    }
  })
}

export function buildVerdict({ kind, leg, exitCode, reports, plan, retryIndex }) {
  const base = { kind, leg, exitCode, schema: SCHEMA }
  const infra = (reason) => ({ ...base, failed: [], reason, verdict: 'infra' })

  if (reports.problems.length) {
    return infra(`unreadable Playwright report: ${reports.problems.join('; ')}`)
  }
  if (reports.reports.length !== 1) {
    return infra(`found ${reports.reports.length} Playwright JSON reports, expected exactly 1`)
  }
  const result = classify({ exitCode, report: reports.reports[0].report })
  const verdict = {
    ...base,
    failed: result.failed,
    reason: result.reason,
    stats: result.stats,
    verdict: result.verdict,
  }

  if (kind === 'quarantine' && result.tests) {
    verdict.tests = result.tests.map((test) => ({
      attempts: test.attempts,
      error: test.error,
      file: test.file,
      line: test.line,
      outcome: test.status === 'flaky' ? 'flaky' : outcomeOf(test),
      title: test.title,
    }))
  }

  if (kind === 'retry') {
    const entry = plan?.retry?.[retryIndex]
    verdict.planId = plan?.planId
    verdict.key = entry?.key
    verdict.outcomes = []
    if (!entry) {
      return { ...verdict, reason: 'no retry plan entry for this leg', verdict: 'infra' }
    }
    if (result.verdict === 'infra') {
      return verdict
    }
    verdict.outcomes = retryOutcomes(entry.tests, result.tests)
    const notRun = verdict.outcomes.filter((o) => o.outcome === 'not-run')
    const notPassed = verdict.outcomes.filter((o) => o.outcome !== 'passed')
    if (notRun.length) {
      return {
        ...verdict,
        reason: `${notRun.length} planned tests were not found in the retry report (first: ${notRun[0].title})`,
        verdict: 'infra',
      }
    }
    if (notPassed.length || result.verdict === 'test-failures') {
      return {
        ...verdict,
        reason: `${notPassed.length || result.failed.length} tests failed again on a fresh runner`,
        verdict: 'test-failures',
      }
    }
  }
  return verdict
}

const validFailed = (failed) =>
  Array.isArray(failed) &&
  failed.every((t) => [t?.file, t?.title, t?.grep].every((v) => typeof v === 'string' && v))

/** A verdict read back from disk; returns a reason when it is not usable. */
export function checkVerdict(json) {
  if (json?.schema !== SCHEMA || json.kind !== 'first') {
    return 'not a first-run leg verdict (schema/kind)'
  }
  if (!VERDICTS.has(json.verdict)) {
    return `unknown verdict "${json.verdict}"`
  }
  const leg = json.leg
  if (!leg || typeof leg.suite !== 'string' || typeof leg.framework !== 'string') {
    return 'leg identity missing'
  }
  if (json.verdict === 'test-failures' && (!validFailed(json.failed) || !json.failed.length)) {
    return 'test-failures verdict without usable failed tests'
  }
  return ''
}

export function buildPlan({ matrixText, verdictFiles, runId, runAttempt }) {
  const legs = matrixLegs(matrixText)
  const expected = new Map(legs.map((leg) => [legKey(leg), leg]))
  const seen = new Map()
  const unexpected = []

  for (const { name, text } of verdictFiles) {
    let json
    try {
      json = JSON.parse(text)
    } catch (error) {
      unexpected.push(`${name}: unreadable (${error.message})`)
      continue
    }
    const problem = checkVerdict(json)
    const key = problem ? null : legKey(json.leg)
    if (problem) {
      unexpected.push(`${name}: ${problem}`)
    } else if (!expected.has(key)) {
      unexpected.push(`${name}: leg ${key} is not in the matrix`)
    } else {
      seen.set(key, [...(seen.get(key) ?? []), json])
    }
  }

  const planned = []
  const planLegs = [...expected.entries()].map(([key, leg]) => {
    const found = seen.get(key) ?? []
    if (!found.length) {
      return { key, reason: 'no verdict artifact', status: 'missing' }
    }
    if (found.length > 1) {
      return { key, reason: `${found.length} verdicts for one leg`, status: 'duplicate' }
    }
    const [verdict] = found
    if (verdict.verdict === 'test-failures') {
      planned.push({ key, leg, tests: verdict.failed })
    }
    const failed =
      verdict.verdict === 'test-failures'
        ? verdict.failed.map(({ file, line, title }) => ({ file, line, title }))
        : undefined
    return { failed, key, reason: verdict.reason ?? '', status: verdict.verdict }
  })

  const systemic =
    planned.length > MAX_RETRY_LEGS ? { cap: MAX_RETRY_LEGS, legs: planned.length } : null
  const retry = systemic ? [] : planned.map((entry, retryIndex) => ({ ...entry, retryIndex }))
  const matrix = {
    include: retry.map(({ leg, retryIndex }) => ({
      cacheComponents: leg.cacheComponents,
      framework: leg.framework,
      parallel: leg.parallel,
      retryIndex,
      shard: leg.shard,
      suite: leg.suite,
      'total-shards': leg.totalShards,
    })),
  }
  return {
    matrix,
    plan: {
      legs: planLegs,
      planId: `${runId}-${runAttempt}`,
      retry,
      schema: SCHEMA,
      systemic,
      unexpected,
    },
  }
}

export function retrySelection(plan, index) {
  const entry = plan?.retry?.[index]
  if (!entry?.tests?.length) {
    throw new Error(`retry plan has no tests for index ${index}`)
  }
  return { grep: entry.tests.map((test) => test.grep), retries: 0 }
}

export function rescuedAsFlaky({ plan, verdict, framework }) {
  const entry = plan.retry.find((candidate) => candidate.key === verdict.key)
  if (!entry) {
    return []
  }
  const byKey = new Map(entry.tests.map((test) => [testKey(test.file, test.title), test]))
  return verdict.outcomes
    .filter((o) => o.outcome === 'passed')
    .map((o) => {
      const first = byKey.get(testKey(o.file, o.title))
      return {
        error: first?.error ?? '',
        file: o.file,
        framework,
        line: o.line,
        project: first?.project,
        retries: Math.max((first?.attempts ?? 1) - 1, 1),
        title: o.title,
        via: 'fresh-runner retry',
      }
    })
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
      console.error(`e2e-leg ${command}: missing ${name}`)
      process.exit(2)
    }
    return value
  }
  const env = process.env

  if (command === 'verdict') {
    const kind = need('--kind')
    const leg = {
      cacheComponents: env.E2E_CACHE_COMPONENTS === 'true',
      framework: env.PAYLOAD_FRAMEWORK ?? '',
      shard: Number(env.E2E_SHARD ?? 1),
      suite: env.SUITE_NAME ?? '',
      totalShards: Number(env.E2E_TOTAL_SHARDS ?? 1),
    }
    const plan = kind === 'retry' ? JSON.parse(readFileSync(need('--plan'), 'utf8')) : undefined
    const verdict = buildVerdict({
      exitCode: Number(need('--exit-code')),
      kind,
      leg,
      plan,
      reports: readReports(need('--dir')),
      retryIndex: kind === 'retry' ? Number(need('--retry-index')) : undefined,
    })
    writeFileSync(need('--out'), JSON.stringify(verdict))

    const label = `${leg.suite} [${leg.framework}] (${leg.shard}/${leg.totalShards})`
    const summary = `${kind} ${label}: ${verdict.verdict}${verdict.reason ? ` (${verdict.reason})` : ''}`
    console.log(summary)
    if (kind === 'retry' && option('--flaky-out')) {
      const flaky = rescuedAsFlaky({ framework: leg.framework, plan, verdict })
      if (flaky.length) {
        const job = `E2E retry - ${label}`
        writeFileSync(
          option('--flaky-out'),
          JSON.stringify({
            flaky,
            job,
            notes: [],
            stats: { executed: verdict.stats?.executed ?? 0 },
          }),
        )
      }
    }
    const handled =
      kind === 'retry'
        ? verdict.verdict === 'pass'
        : verdict.verdict === 'pass' || verdict.verdict === 'test-failures'
    if (verdict.verdict === 'test-failures' && kind !== 'retry') {
      console.log(`::warning title=E2E leg::${summary}; failed tests go to a fresh-runner retry`)
    }
    if (!handled) {
      console.log(`::error title=E2E leg::${summary}`)
    }
    process.exit(handled ? 0 : 1)
  } else if (command === 'plan') {
    const directory = need('--verdicts')
    const names = (existsSync(directory) ? readdirSync(directory) : [])
      .filter((name) => /^leg-verdict-.*\.json$/.test(name))
      .sort()
    const { matrix, plan } = buildPlan({
      matrixText: env.E2E_MATRIX ?? '',
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      runId: env.GITHUB_RUN_ID,
      verdictFiles: names.map((name) => ({
        name,
        text: readFileSync(path.join(directory, name), 'utf8'),
      })),
    })
    writeFileSync(need('--out'), JSON.stringify(plan))
    const counts = {}
    for (const leg of plan.legs) {
      counts[leg.status] = (counts[leg.status] ?? 0) + 1
    }
    console.log(
      `plan ${plan.planId}: ${JSON.stringify(counts)}; ${plan.retry.length} legs to retry`,
    )
    for (const problem of plan.unexpected) {
      console.log(`::warning title=E2E retry plan::${problem}`)
    }
    if (env.GITHUB_OUTPUT) {
      appendFileSync(
        env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(matrix)}\ncount=${plan.retry.length}\n`,
      )
    }
  } else if (command === 'select-retry') {
    const plan = JSON.parse(readFileSync(need('--plan'), 'utf8'))
    writeFileSync(need('--out'), JSON.stringify(retrySelection(plan, Number(need('--index')))))
  } else {
    console.error('usage: e2e-leg.mjs verdict|plan|select-retry ...')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
