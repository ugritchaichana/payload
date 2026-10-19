// The E2E part of the All Green verdict: every leg reported, every failed test was retried once on
// a fresh runner, and every retried test passed there.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { legKey, matrixLegs, MAX_RETRY_LEGS, testKey } from './e2e-report.mjs'

const label = (test) => `${test.where ?? `${test.file}:${test.line}`} ${test.title}`

/** Plan and retry results as written by `e2e-leg.mjs`; an unreadable file is kept as `error`. */
export function loadE2eArtifacts(directory) {
  const read = (name) => {
    try {
      return { name, json: JSON.parse(readFileSync(path.join(directory, name), 'utf8')) }
    } catch (error) {
      return { name, error: error.message }
    }
  }
  const names = existsSync(directory) ? readdirSync(directory).sort() : []
  return {
    plan: names.includes('gate-e2e-plan.json') ? read('gate-e2e-plan.json') : null,
    retryResults: names.filter((name) => /^gate-e2e-retry-.*\.json$/.test(name)).map(read),
  }
}

/** `failures` fail the gate; `rescued` passed on the fresh-runner retry (flaky); `red` failed again. */
export function evaluateE2e({ matrixText, artifacts, planId, retryCountOutput }) {
  const failures = []
  const rescued = []
  const red = []
  const fail = (message) => failures.push(message)

  let legs
  try {
    legs = matrixLegs(matrixText ?? '')
  } catch (error) {
    return {
      failures: [`e2e matrix output is unusable: ${error.message}`],
      red,
      rescued,
      retried: 0,
    }
  }
  const keys = legs.map(legKey)
  if (new Set(keys).size !== keys.length) {
    fail('e2e matrix lists the same leg twice')
  }
  for (const leg of legs.filter((l) => l.optional)) {
    fail(
      `${legKey(leg)}: matrix marks the leg optional (continue-on-error); the gate cannot see its failure`,
    )
  }

  const planFile = artifacts?.plan
  if (!planFile || planFile.error) {
    fail(
      planFile
        ? `retry plan is unreadable (${planFile.error})`
        : 'retry plan artifact is missing: the e2e-retry-plan job did not report',
    )
    return { failures, red, rescued, retried: 0 }
  }
  const plan = planFile.json
  if (plan?.schema !== 1 || !Array.isArray(plan.legs) || !Array.isArray(plan.retry)) {
    fail('retry plan has an unknown shape')
    return { failures, red, rescued, retried: 0 }
  }
  if (plan.planId !== planId) {
    fail(`retry plan belongs to ${plan.planId}, this run is ${planId}`)
    return { failures, red, rescued, retried: 0 }
  }
  for (const problem of plan.unexpected ?? []) {
    fail(`verdict artifact problem: ${problem}`)
  }
  if (String(plan.retry.length) !== String(retryCountOutput)) {
    fail(
      `retry plan lists ${plan.retry.length} legs but the plan job output says ${retryCountOutput}`,
    )
  }

  const failedLegs = plan.legs.filter((leg) => leg.status === 'test-failures')
  const systemic = Boolean(plan.systemic) || failedLegs.length > MAX_RETRY_LEGS
  if (systemic) {
    fail(
      `systemic failure: ${failedLegs.length} legs have failed tests, more than the cap of ${MAX_RETRY_LEGS}; nothing was retried`,
    )
  }
  const planned = new Map(plan.retry.map((entry) => [entry.key, entry]))
  const byKey = new Map(plan.legs.map((leg) => [leg.key, leg]))
  for (const key of keys) {
    const leg = byKey.get(key)
    if (!leg) {
      fail(`${key}: the plan has no entry for this leg`)
    } else if (leg.status === 'test-failures') {
      if (systemic) {
        continue
      }
      const entry = planned.get(key)
      const scheduled = new Set((entry?.tests ?? []).map((t) => testKey(t.file, t.title)))
      for (const test of leg.failed ?? []) {
        if (!scheduled.has(testKey(test.file, test.title))) {
          fail(`${label(test)}: failed in ${key} but was not scheduled for a fresh-runner retry`)
        }
      }
      if (!leg.failed?.length) {
        fail(`${key}: test-failures without a failed test list`)
      }
    } else if (leg.status !== 'pass') {
      fail(`${key}: ${leg.status}${leg.reason ? ` (${leg.reason})` : ''}`)
    }
  }
  for (const leg of plan.legs) {
    if (!keys.includes(leg.key)) {
      fail(`${leg.key}: plan entry for a leg that is not in the matrix`)
    }
  }

  const results = artifacts.retryResults ?? []
  for (const result of results.filter((r) => r.error)) {
    fail(`${result.name}: retry result is unreadable (${result.error})`)
  }
  for (const entry of plan.retry) {
    const matching = results.filter((r) => r.json?.key === entry.key)
    if (!matching.length) {
      fail(`${entry.key}: retry result is missing: the retry leg did not report`)
      continue
    }
    if (matching.length > 1) {
      fail(`${entry.key}: ${matching.length} retry results for one leg`)
      continue
    }
    const result = matching[0].json
    if (result.schema !== 1 || result.kind !== 'retry' || result.planId !== planId) {
      fail(
        `${entry.key}: retry result is stale or malformed (plan ${result.planId}, this run ${planId})`,
      )
      continue
    }
    const outcomes = new Map((result.outcomes ?? []).map((o) => [testKey(o.file, o.title), o]))
    for (const test of entry.tests) {
      const outcome = outcomes.get(testKey(test.file, test.title))
      if (!outcome || outcome.outcome === 'not-run') {
        fail(`${label(test)}: was not executed by the retry leg`)
      } else if (outcome.outcome === 'passed') {
        rescued.push({ ...test, framework: result.leg?.framework, key: entry.key })
      } else {
        red.push({ ...test, framework: result.leg?.framework, key: entry.key })
        fail(`${label(test)}: failed again on a fresh runner (${outcome.outcome}): the test is red`)
      }
    }
    if (result.verdict !== 'pass') {
      fail(`${entry.key}: retry leg verdict is ${result.verdict} (${result.reason ?? ''})`)
    }
  }
  return { failures, red, rescued, retried: plan.retry.length }
}
