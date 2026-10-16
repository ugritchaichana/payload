import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { evaluate, NOT_GATED, POLICY, renderSummary } from './gate.mjs'
import { parseJobs } from './lib/workflow.mjs'

const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')

const ALL_TRUE = {
  build_approvals: 'false',
  needs_build: 'true',
  needs_tests: 'true',
  needs_visual: 'true',
  templates: 'true',
}
const ALL_FALSE = {
  build_approvals: 'false',
  needs_build: 'false',
  needs_tests: 'false',
  needs_visual: 'false',
  templates: 'false',
}

function needsOf(outputs, results = {}) {
  const needs = {}
  for (const name of Object.keys(POLICY)) {
    needs[name] = { result: results[name] ?? 'success', outputs: {} }
  }
  needs.changes.outputs = outputs
  return needs
}

// Verdict of the pre-fix gate: it listed ten jobs and failed only on failure or cancelled.
const LEGACY_NEEDS = [
  'lint',
  'build',
  'build-and-test-templates',
  'tests-unit',
  'tests-int',
  'tests-e2e',
  'tests-types',
  'tests-type-generation',
  'tests-content-api',
  'visual-regression',
]
function legacyVerdict(needs) {
  const results = LEGACY_NEEDS.map((name) => needs[name]?.result)
  return results.includes('failure') || results.includes('cancelled') ? 'fail' : 'pass'
}

describe('gate verdict', () => {
  test('every required job succeeded: pass', () => {
    assert.equal(evaluate(needsOf(ALL_TRUE)).ok, true)
  })

  test('docs-only change: legitimate skips pass', () => {
    const skipped = Object.fromEntries(
      Object.entries(POLICY)
        .filter(([, policy]) => policy.runs !== 'always')
        .map(([name]) => [name, 'skipped']),
    )
    const verdict = evaluate(needsOf(ALL_FALSE, skipped))
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.ok, true)
  })

  test('templates filter false: skipping only template jobs passes', () => {
    const outputs = { ...ALL_TRUE, needs_build: 'false', templates: 'false', needs_tests: 'false' }
    const results = {
      analyze: 'skipped',
      build: 'skipped',
      'build-and-test-templates': 'skipped',
      'e2e-prep': 'skipped',
      'probe-next-canary': 'skipped',
      'tests-content-api': 'skipped',
      'tests-e2e': 'skipped',
      'tests-int': 'skipped',
      'tests-type-generation': 'skipped',
      'tests-types': 'skipped',
    }
    assert.equal(evaluate(needsOf(outputs, results)).ok, true)
  })

  test('needs_visual false: skipped visual-regression passes', () => {
    const outputs = { ...ALL_TRUE, needs_visual: 'false' }
    assert.equal(evaluate(needsOf(outputs, { 'visual-regression': 'skipped' })).ok, true)
  })

  test('needs_visual true: skipped visual-regression fails', () => {
    const verdict = evaluate(needsOf(ALL_TRUE, { 'visual-regression': 'skipped' }))
    assert.equal(verdict.ok, false)
    assert.match(verdict.failures.join('\n'), /visual-regression: skipped although selected/)
  })

  test('upstream false green: E2E Prep failed, E2E skipped (run 38782485782 attempt 1)', () => {
    const needs = needsOf(
      { ...ALL_TRUE, needs_visual: 'false' },
      { 'e2e-prep': 'failure', 'tests-e2e': 'skipped', 'visual-regression': 'skipped' },
    )
    assert.equal(legacyVerdict(needs), 'pass', 'the old gate calls this run green')
    const verdict = evaluate(needs)
    assert.equal(verdict.ok, false)
    assert.match(verdict.failures.join('\n'), /e2e-prep: failure/)
    assert.match(verdict.failures.join('\n'), /tests-e2e: skipped although selected/)
  })

  test('skip caused by a failed matrix generator fails', () => {
    for (const [matrix, dependent] of [
      ['int-matrix', 'tests-int'],
      ['e2e-matrix', 'tests-e2e'],
    ]) {
      const needs = needsOf(ALL_TRUE, { [dependent]: 'skipped', [matrix]: 'failure' })
      assert.equal(legacyVerdict(needs), 'pass')
      assert.equal(evaluate(needs).ok, false, matrix)
    }
  })

  test('canary probe failure that skips tests-int fails', () => {
    const needs = needsOf(ALL_TRUE, { 'probe-next-canary': 'failure', 'tests-int': 'skipped' })
    assert.equal(legacyVerdict(needs), 'pass')
    assert.equal(evaluate(needs).ok, false)
  })

  test('failed changes job fails even though every dependent was skipped', () => {
    const skipped = Object.fromEntries(
      Object.entries(POLICY)
        .filter(([name]) => name !== 'lint' && name !== 'changes')
        .map(([name]) => [name, 'skipped']),
    )
    const needs = needsOf({}, { ...skipped, changes: 'failure' })
    assert.equal(legacyVerdict(needs), 'pass')
    assert.equal(evaluate(needs).ok, false)
  })

  test('selection outputs that are not true/false fail', () => {
    const verdict = evaluate(needsOf({ ...ALL_FALSE, needs_tests: '' }))
    assert.equal(verdict.ok, false)
    assert.match(verdict.failures.join('\n'), /needs_tests/)
  })

  test('failure and cancelled still fail', () => {
    for (const result of ['failure', 'cancelled']) {
      assert.equal(evaluate(needsOf(ALL_TRUE, { 'tests-int': result })).ok, false, result)
    }
  })

  test('tests-content-api: any result is reported, never passed off as evidence', () => {
    for (const result of ['success', 'failure', 'skipped']) {
      const verdict = evaluate(needsOf(ALL_TRUE, { 'tests-content-api': result }))
      assert.equal(verdict.ok, true, result)
    }
    const skipped = evaluate(needsOf(ALL_TRUE, { 'tests-content-api': 'skipped' }))
    assert.equal(skipped.rows.find((row) => row.name === 'tests-content-api').verdict, 'not run')
    const ran = evaluate(needsOf(ALL_TRUE, { 'tests-content-api': 'success' }))
    assert.equal(ran.rows.find((row) => row.name === 'tests-content-api').verdict, 'advisory')
  })

  test('analyze is advisory: a failure warns but does not fail the gate', () => {
    const verdict = evaluate(needsOf(ALL_TRUE, { analyze: 'failure' }))
    assert.equal(verdict.ok, true)
    assert.match(verdict.warnings.join('\n'), /analyze: failure/)
  })

  test('a job the gate does not know about fails', () => {
    const needs = needsOf(ALL_TRUE)
    needs['brand-new-job'] = { result: 'success', outputs: {} }
    assert.match(evaluate(needs).failures.join('\n'), /brand-new-job: not classified/)
  })

  test('a job missing from needs fails', () => {
    const needs = needsOf(ALL_TRUE)
    delete needs['tests-e2e']
    assert.match(evaluate(needs).failures.join('\n'), /tests-e2e: missing from the gate's needs/)
  })

  test('summary names the verdict and every failure', () => {
    const verdict = evaluate(needsOf(ALL_TRUE, { 'e2e-prep': 'failure' }))
    const text = renderSummary(verdict)
    assert.match(text, /All Green: FAIL/)
    assert.match(text, /e2e-prep: failure/)
  })
})

describe('gate wiring in main.yml', () => {
  const jobs = parseJobs(readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8'))
  const gateNeeds = jobs.get('all-green')?.needs ?? []

  test('all-green needs exactly the jobs the policy classifies', () => {
    assert.deepEqual([...gateNeeds].sort(), Object.keys(POLICY).sort())
  })

  test('every other job is explicitly not gated, with a reason', () => {
    const rest = [...jobs.keys()].filter(
      (name) => name !== 'all-green' && !gateNeeds.includes(name),
    )
    assert.deepEqual(rest.sort(), Object.keys(NOT_GATED).sort())
    for (const reason of Object.values(NOT_GATED)) {
      assert.ok(reason.length > 0)
    }
  })
})
