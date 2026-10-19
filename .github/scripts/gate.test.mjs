import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { evaluate as evaluateGate, NOT_GATED, POLICY, renderSummary } from './gate.mjs'
import { parseJobs } from './lib/workflow.mjs'

const root = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, '../..')

const PLAN_ID = '777-1'
const matrixEntry = (suite, framework, shard, total) => ({
  cacheComponents: false,
  framework,
  optional: false,
  parallel: false,
  shard,
  suite,
  'total-shards': total,
})
const MATRIX = {
  include: [
    matrixEntry('auth', 'next', 1, 1),
    matrixEntry('versions', 'next', 1, 2),
    matrixEntry('versions', 'next', 2, 2),
    matrixEntry('auth', 'tanstack-start', 1, 1),
  ],
}
const keyOf = (entry) =>
  [entry.suite, entry.framework, entry.shard, entry['total-shards'], false].join('|')
const KEYS = MATRIX.include.map(keyOf)

const failedTest = (title, extra = {}) => ({
  attempts: 6,
  error: 'locator timeout',
  file: 'test/auth/e2e.spec.ts',
  grep: `^\\S+ auth[\\\\/]e2e\\.spec\\.ts ${title}$`,
  line: 297,
  project: 'chromium',
  title,
  titlePath: [title],
  ...extra,
})

/** Plan as `e2e-leg.mjs plan` writes it; `failing` maps a leg key to its failed tests. */
function planOf({ failing = {}, over = {} } = {}) {
  const retry = Object.entries(failing).map(([key, tests], retryIndex) => ({
    key,
    leg: {},
    retryIndex,
    tests,
  }))
  return {
    legs: KEYS.map((key) => ({
      failed: failing[key]?.map(({ file, line, title }) => ({ file, line, title })),
      key,
      reason: '',
      status: failing[key] ? 'test-failures' : 'pass',
    })),
    planId: PLAN_ID,
    retry,
    schema: 1,
    unexpected: [],
    ...over,
  }
}

const retryResultOf = (key, tests, outcome = 'passed', over = {}) => ({
  name: `gate-e2e-retry-${key.length}.json`,
  json: {
    key,
    kind: 'retry',
    leg: { framework: key.split('|')[1], suite: key.split('|')[0] },
    outcomes: tests.map((t) => ({ file: t.file, line: t.line, outcome, title: t.title })),
    planId: PLAN_ID,
    reason: '',
    schema: 1,
    verdict: outcome === 'passed' ? 'pass' : 'test-failures',
    ...over,
  },
})

const e2eOf = ({ plan = planOf(), retryResults = [] } = {}) => ({
  artifacts: { plan: plan && { json: plan, name: 'gate-e2e-plan.json' }, retryResults },
  planId: PLAN_ID,
})
const healthyE2e = () => e2eOf()

const evaluate = (needs, e2e = healthyE2e()) => evaluateGate(needs, e2e)

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
  needs['e2e-matrix'].outputs = { matrix: JSON.stringify(MATRIX), quarantine_count: '0' }
  needs['e2e-retry-plan'].outputs = { count: '0' }
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

  test('check-template-build-approvals is advisory: a failure is listed but does not fail the gate', () => {
    const outputs = { ...ALL_TRUE, build_approvals: 'true' }
    const verdict = evaluate(needsOf(outputs, { 'check-template-build-approvals': 'failure' }))
    assert.equal(verdict.ok, true)
    assert.match(verdict.warnings.join('\n'), /check-template-build-approvals: failure/)
    const row = verdict.rows.find((r) => r.name === 'check-template-build-approvals')
    assert.equal(row.verdict, 'advisory')
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

describe('E2E verdicts and the fresh-runner retry', () => {
  const failures = (verdict) => verdict.failures.join('\n')
  const authTest = failedTest('should have up-to-date user')
  const versionsTest = failedTest('autosave', { file: 'test/versions/e2e.spec.ts', line: 565 })
  const authKey = KEYS[0]
  const versionsKey = KEYS[1]
  const retryNeeds = (results = {}, count = '1') => {
    const needs = needsOf(ALL_TRUE, results)
    needs['e2e-retry-plan'].outputs = { count }
    return needs
  }

  test('every leg passed and nothing was retried: pass', () => {
    const verdict = evaluate(needsOf(ALL_TRUE))
    assert.equal(verdict.ok, true)
    assert.equal(verdict.e2e.retried, 0)
  })

  test('a leg with no verdict artifact fails', () => {
    const plan = planOf()
    plan.legs[1] = { key: versionsKey, reason: 'no verdict artifact', status: 'missing' }
    const verdict = evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /versions\|next\|1\|2\|false: missing \(no verdict artifact\)/)
  })

  test('an unreadable or unknown verdict artifact fails', () => {
    const plan = planOf({
      over: { unexpected: ['gate-e2e-verdict-3.json: unreadable (bad json)'] },
    })
    const verdict = evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /gate-e2e-verdict-3\.json: unreadable/)
  })

  test('a leg that failed for a non-test reason fails and is not retried', () => {
    const plan = planOf()
    plan.legs[0] = { key: authKey, reason: 'Playwright reported an error: setup', status: 'infra' }
    const verdict = evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /auth\|next\|1\|1\|false: infra \(Playwright reported an error/)
    assert.deepEqual(plan.retry, [])
  })

  test('a matrix leg that the plan does not list fails', () => {
    const plan = planOf()
    plan.legs.pop()
    assert.match(failures(evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))), /no entry for this leg/)
  })

  test('a plan entry for a leg outside the matrix fails', () => {
    const plan = planOf()
    plan.legs.push({ key: 'ghost|next|1|1|false', reason: '', status: 'pass' })
    assert.match(failures(evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))), /not in the matrix/)
  })

  test('an optional matrix leg fails, because continue-on-error hides it from the gate', () => {
    const needs = needsOf(ALL_TRUE)
    const matrix = structuredClone(MATRIX)
    matrix.include[0].optional = true
    needs['e2e-matrix'].outputs.matrix = JSON.stringify(matrix)
    assert.match(failures(evaluate(needs)), /marks the leg optional/)
  })

  test('an unusable matrix output fails', () => {
    const needs = needsOf(ALL_TRUE)
    needs['e2e-matrix'].outputs.matrix = '{"include":[]}'
    assert.match(failures(evaluate(needs)), /e2e matrix output is unusable/)
  })

  test('failed tests with no retry plan artifact fail', () => {
    const verdict = evaluate(retryNeeds(), e2eOf({ plan: null }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /retry plan artifact is missing/)
  })

  test('an unreadable retry plan fails', () => {
    const e2e = e2eOf()
    e2e.artifacts.plan = { error: 'Unexpected token', name: 'gate-e2e-plan.json' }
    assert.match(failures(evaluate(needsOf(ALL_TRUE), e2e)), /retry plan is unreadable/)
  })

  test('a retry plan from another run attempt fails', () => {
    const plan = planOf({ over: { planId: '777-0' } })
    assert.match(failures(evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))), /belongs to 777-0/)
  })

  test('a failed test the plan did not schedule for retry fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest, failedTest('second failure')] } })
    plan.retry[0].tests = [authTest]
    const needs = retryNeeds()
    const verdict = evaluate(
      needs,
      e2eOf({ plan, retryResults: [retryResultOf(authKey, [authTest])] }),
    )
    assert.equal(verdict.ok, false)
    assert.match(
      failures(verdict),
      /second failure: failed in auth\|next\|1\|1\|false but was not scheduled/,
    )
  })

  test('a leg with test failures but no retry entry fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    plan.retry = []
    assert.match(
      failures(evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))),
      /should have up-to-date user: failed in .* but was not scheduled/,
    )
  })

  test('a plan whose retry count disagrees with the plan job output fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [retryResultOf(authKey, [authTest])]
    const verdict = evaluate(retryNeeds({}, '3'), e2eOf({ plan, retryResults: results }))
    assert.match(failures(verdict), /lists 1 legs but the plan job output says 3/)
  })

  test('the retry job skipped although a retry was planned fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const verdict = evaluate(retryNeeds({ 'tests-e2e-retry': 'skipped' }), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /tests-e2e-retry: skipped although selected/)
  })

  test('the retry job failing fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [retryResultOf(authKey, [authTest])]
    const verdict = evaluate(
      retryNeeds({ 'tests-e2e-retry': 'failure' }),
      e2eOf({ plan, retryResults: results }),
    )
    assert.match(failures(verdict), /tests-e2e-retry: failure/)
  })

  test('the retry job skipped with nothing to retry passes', () => {
    const verdict = evaluate(needsOf(ALL_TRUE, { 'tests-e2e-retry': 'skipped' }))
    assert.equal(verdict.ok, true)
  })

  test('a planned leg without a retry result fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const verdict = evaluate(retryNeeds(), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /retry result is missing: the retry leg did not report/)
  })

  test('an unreadable retry result fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [{ error: 'Unexpected end of JSON', name: 'gate-e2e-retry-0.json' }]
    assert.match(
      failures(evaluate(retryNeeds(), e2eOf({ plan, retryResults: results }))),
      /gate-e2e-retry-0\.json: retry result is unreadable/,
    )
  })

  test('a retry result from another plan fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [retryResultOf(authKey, [authTest], 'passed', { planId: '777-0' })]
    assert.match(
      failures(evaluate(retryNeeds(), e2eOf({ plan, retryResults: results }))),
      /retry result is stale or malformed/,
    )
  })

  test('a retried test that failed again is red and fails the gate', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [retryResultOf(authKey, [authTest], 'failed')]
    const verdict = evaluate(retryNeeds(), e2eOf({ plan, retryResults: results }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /should have up-to-date user: failed again on a fresh runner/)
    assert.equal(verdict.e2e.red.length, 1)
    assert.equal(verdict.e2e.rescued.length, 0)
  })

  test('a planned test the retry leg never executed fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    for (const outcome of ['not-run', 'skipped']) {
      const results = [retryResultOf(authKey, [authTest], outcome)]
      const verdict = evaluate(retryNeeds(), e2eOf({ plan, retryResults: results }))
      assert.equal(verdict.ok, false, outcome)
    }
    const empty = [retryResultOf(authKey, [], 'passed')]
    assert.match(
      failures(evaluate(retryNeeds(), e2eOf({ plan, retryResults: empty }))),
      /was not executed by the retry leg/,
    )
  })

  test('a retry leg that ended infra fails even if every outcome says passed', () => {
    const plan = planOf({ failing: { [authKey]: [authTest] } })
    const results = [
      retryResultOf(authKey, [authTest], 'passed', { reason: 'server died', verdict: 'infra' }),
    ]
    assert.match(
      failures(evaluate(retryNeeds(), e2eOf({ plan, retryResults: results }))),
      /retry leg verdict is infra \(server died\)/,
    )
  })

  test('the retry passes: the gate passes and lists the test as flaky', () => {
    const plan = planOf({
      failing: { [authKey]: [authTest], [versionsKey]: [versionsTest] },
    })
    const results = [
      retryResultOf(authKey, [authTest]),
      { ...retryResultOf(versionsKey, [versionsTest]), name: 'gate-e2e-retry-1.json' },
    ]
    const verdict = evaluate(retryNeeds({}, '2'), e2eOf({ plan, retryResults: results }))
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.ok, true)
    assert.deepEqual(
      verdict.e2e.rescued.map((t) => t.title),
      ['should have up-to-date user', 'autosave'],
    )
    const text = renderSummary(verdict)
    assert.match(text, /E2E fresh-runner retry: 2 legs retried/)
    assert.match(text, /reported as flaky \(2\)/)
    assert.match(text, /test\/auth\/e2e\.spec\.ts:297 should have up-to-date user/)
  })

  test('one retried test still red among passing ones fails', () => {
    const plan = planOf({ failing: { [authKey]: [authTest, failedTest('second')] } })
    const result = retryResultOf(authKey, [authTest, failedTest('second')])
    result.json.outcomes[1].outcome = 'failed'
    const verdict = evaluate(retryNeeds(), e2eOf({ plan, retryResults: [result] }))
    assert.equal(verdict.ok, false)
    assert.deepEqual(
      verdict.e2e.rescued.map((t) => t.title),
      ['should have up-to-date user'],
    )
    assert.deepEqual(
      verdict.e2e.red.map((t) => t.title),
      ['second'],
    )
  })

  test('more failing legs than the cap is a systemic failure: red, with that reason', () => {
    const plan = planOf({ over: { retry: [], systemic: { cap: 3, legs: 4 } } })
    plan.legs = [
      ...plan.legs,
      ...[1, 2, 3, 4].map((n) => ({
        failed: [],
        key: `x${n}|next|1|1|false`,
        status: 'test-failures',
      })),
    ]
    const verdict = evaluate(needsOf(ALL_TRUE), e2eOf({ plan }))
    assert.equal(verdict.ok, false)
    assert.match(
      failures(verdict),
      /systemic failure: 4 legs have failed tests, more than the cap of 3/,
    )
  })

  test('the gate counts the failing legs itself, so a plan that hides a systemic run still fails', () => {
    const failing = Object.fromEntries(KEYS.map((key) => [key, [authTest]]))
    const plan = planOf({ failing })
    plan.legs.push({ failed: [], key: 'extra|next|1|1|false', status: 'test-failures' })
    const verdict = evaluate(retryNeeds({}, '4'), e2eOf({ plan }))
    assert.match(failures(verdict), /systemic failure/)
  })

  test('at the cap the failing legs are retried, not called systemic', () => {
    const failing = Object.fromEntries(KEYS.slice(0, 3).map((key) => [key, [authTest]]))
    const plan = planOf({ failing })
    const results = KEYS.slice(0, 3).map((key, i) => ({
      ...retryResultOf(key, [authTest]),
      name: `gate-e2e-retry-${i}.json`,
    }))
    const verdict = evaluate(retryNeeds({}, '3'), e2eOf({ plan, retryResults: results }))
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.e2e.rescued.length, 3)
  })

  test('tests-e2e not selected: no E2E artifacts are needed', () => {
    const outputs = { ...ALL_FALSE }
    const skipped = Object.fromEntries(
      Object.entries(POLICY)
        .filter(([, policy]) => policy.runs !== 'always')
        .map(([name]) => [name, 'skipped']),
    )
    assert.equal(evaluateGate(needsOf(outputs, skipped)).ok, true)
  })

  test('E2E ran but the gate was given no artifacts: fail', () => {
    assert.match(failures(evaluateGate(needsOf(ALL_TRUE))), /not given the E2E verdict artifacts/)
  })
})

describe('quarantine job in the gate', () => {
  const withCount = (count, results) => {
    const needs = needsOf(ALL_TRUE, results)
    needs['e2e-matrix'].outputs.quarantine_count = count
    return needs
  }

  test('a failing quarantine job warns and never fails the gate', () => {
    const verdict = evaluate(withCount('3', { 'tests-quarantine': 'failure' }))
    assert.equal(verdict.ok, true)
    assert.match(verdict.warnings.join('\n'), /tests-quarantine: failure/)
  })

  test('a quarantine job that did not run although entries exist fails', () => {
    const verdict = evaluate(withCount('3', { 'tests-quarantine': 'skipped' }))
    assert.equal(verdict.ok, false)
    assert.match(failures(verdict), /tests-quarantine: skipped although expected/)
  })

  test('no quarantine entries: the job is legitimately skipped', () => {
    assert.equal(evaluate(withCount('0', { 'tests-quarantine': 'skipped' })).ok, true)
  })

  test('a quarantine count that is not a number fails', () => {
    assert.match(failures(evaluate(withCount('', {}))), /quarantine_count is ""/)
  })

  function failures(verdict) {
    return verdict.failures.join('\n')
  }
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
