#!/usr/bin/env node
// All Green verdict from toJSON(needs): fails on failure, cancelled, or skipped-although-selected.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { evaluateE2e, loadE2eArtifacts } from './lib/e2e-gate.mjs'

const FAMILIES = ['needs_build', 'needs_tests', 'needs_visual', 'build_approvals', 'templates']

/**
 * `runs`: 'always' or the `changes` outputs that select the job (any one true selects it).
 * `onlyWhen`: a second run condition (a retry was planned, quarantine entries exist).
 * `advisory`: result is reported but never fails the gate, and a skip is not a defect.
 * `mustRun`: with `advisory`, a skip while the job was expected still fails the gate.
 */
export const POLICY = {
  changes: { runs: 'always' },
  lint: { runs: 'always' },
  'int-matrix': { runs: 'always' },
  'e2e-matrix': { runs: 'always' },
  'pipeline-checks': { runs: 'always' },
  build: { runs: ['needs_build'] },
  'build-and-test-templates': { runs: ['needs_build', 'templates'] },
  'check-template-build-approvals': {
    runs: ['build_approvals'],
    advisory: 'approval policy check, not gating upstream',
  },
  'probe-next-canary': { runs: ['needs_tests'] },
  'tests-unit': { runs: ['needs_tests', 'needs_visual'] },
  'tests-types': { runs: ['needs_tests'] },
  'tests-type-generation': { runs: ['needs_tests'] },
  'tests-int': { runs: ['needs_tests'] },
  'e2e-prep': { runs: ['needs_tests'] },
  'tests-e2e': { runs: ['needs_tests'] },
  'e2e-retry-plan': { runs: ['needs_tests'] },
  'tests-e2e-retry': { runs: ['needs_tests'], onlyWhen: 'retryPlanned' },
  'tests-quarantine': {
    runs: ['needs_tests'],
    onlyWhen: 'quarantineListed',
    advisory: 'quarantined tests are reported, never gating',
    mustRun: true,
  },
  'visual-regression': { runs: ['needs_visual'] },
  analyze: {
    runs: ['needs_build'],
    advisory: 'bundle-size report, not gating upstream',
  },
  'tests-content-api': {
    runs: ['needs_tests'],
    advisory:
      'needs upstream-only cloud credentials and is continue-on-error; its result is not evidence',
  },
}

/** Jobs of main.yml that the gate deliberately does not depend on. */
export const NOT_GATED = {
  'flaky-report': 'reporting only; waiting for it would lengthen the critical path',
  'publish-canary': 'runs after the gate and depends on it',
}

const BAD = new Set(['failure', 'cancelled'])

/**
 * `e2e`: `{ artifacts, planId }` as loaded by `loadE2eArtifacts`; required once the E2E matrix
 * jobs succeeded, because their verdict files are the only evidence of which tests failed.
 */
export function evaluate(needs, e2e) {
  const rows = []
  const failures = []
  const warnings = []

  const outputs = needs.changes?.outputs ?? {}
  const selected = {}
  for (const family of FAMILIES) {
    const value = outputs[family]
    if (value !== 'true' && value !== 'false') {
      failures.push(
        `changes output "${family}" is "${value ?? ''}", not true/false: selection unknown`,
      )
    }
    selected[family] = value === 'true'
  }

  for (const name of Object.keys(needs)) {
    if (!(name in POLICY)) {
      failures.push(`${name}: not classified in gate.mjs POLICY`)
    }
  }

  const planOutput = needs['e2e-retry-plan']?.outputs?.count
  const quarantineOutput = needs['e2e-matrix']?.outputs?.quarantine_count
  const planned = e2e?.artifacts?.plan?.json?.retry?.length
  const conditions = {
    quarantineListed: Number(quarantineOutput) > 0,
    retryPlanned: Math.max(Number(planOutput) || 0, planned || 0) > 0,
  }

  let e2eResult = null
  if (selected.needs_tests && needs['tests-e2e']?.result === 'success') {
    if (!Number.isInteger(Number(quarantineOutput)) || quarantineOutput === '') {
      failures.push(
        `e2e-matrix output quarantine_count is "${quarantineOutput ?? ''}", not a number`,
      )
    }
    if (!e2e) {
      failures.push('the gate was not given the E2E verdict artifacts')
    } else {
      e2eResult = evaluateE2e({
        artifacts: e2e.artifacts,
        matrixText: needs['e2e-matrix']?.outputs?.matrix,
        planId: e2e.planId,
        retryCountOutput: planOutput,
      })
      failures.push(...e2eResult.failures)
    }
  }

  for (const [name, policy] of Object.entries(POLICY)) {
    const job = needs[name]
    if (!job) {
      failures.push(`${name}: missing from the gate's needs`)
      rows.push({ name, result: 'missing', verdict: 'FAIL', note: 'not wired into all-green' })
      continue
    }
    const result = job.result
    const expected =
      (policy.runs === 'always' || policy.runs.some((family) => selected[family])) &&
      (!policy.onlyWhen || conditions[policy.onlyWhen])
    let verdict = 'ok'
    let note = ''

    if (policy.advisory) {
      note = policy.advisory
      if (result === 'success') {
        verdict = 'advisory'
      } else if (result === 'skipped') {
        verdict = 'not run'
        if (policy.mustRun && expected) {
          verdict = 'FAIL'
          note = `skipped although expected (${policy.advisory})`
          failures.push(`${name}: ${note}`)
        }
      } else {
        verdict = 'advisory'
        warnings.push(`${name}: ${result} (${policy.advisory})`)
      }
    } else if (BAD.has(result)) {
      verdict = 'FAIL'
      failures.push(`${name}: ${result}`)
    } else if (result === 'skipped') {
      if (expected) {
        verdict = 'FAIL'
        note = `skipped although selected (${policy.runs === 'always' ? 'always runs' : policy.runs.join(' or ')})`
        failures.push(`${name}: ${note}`)
      } else {
        verdict = 'skipped (not selected)'
      }
    } else if (result !== 'success') {
      verdict = 'FAIL'
      failures.push(`${name}: unexpected result "${result}"`)
    }
    rows.push({ name, result, verdict, note })
  }

  return { ok: failures.length === 0, failures, warnings, rows, selected, e2e: e2eResult }
}

const testLine = (test) =>
  `- ${test.framework} ${test.where ?? `${test.file}:${test.line}`} ${test.title}`

export function renderSummary({ ok, failures, warnings, rows, selected, e2e }) {
  const lines = [
    `## All Green: ${ok ? 'PASS' : 'FAIL'}`,
    '',
    `Selection: ${Object.entries(selected)
      .map(([family, value]) => `${family}=${value}`)
      .join(', ')}`,
    '',
    '| job | result | verdict |',
    '| --- | --- | --- |',
    ...rows.map(
      (row) => `| ${row.name} | ${row.result} | ${row.verdict}${row.note ? `: ${row.note}` : ''} |`,
    ),
  ]
  if (e2e?.retried) {
    lines.push('', `### E2E fresh-runner retry: ${e2e.retried} legs retried`)
    if (e2e.rescued.length) {
      lines.push(
        '',
        `Passed on the fresh runner, so reported as flaky (${e2e.rescued.length}):`,
        ...e2e.rescued.map(testLine),
      )
    }
    if (e2e.red.length) {
      lines.push(
        '',
        `Failed again on the fresh runner, so red (${e2e.red.length}):`,
        ...e2e.red.map(testLine),
      )
    }
  }
  if (failures.length) {
    lines.push('', '### Failures', ...failures.map((failure) => `- ${failure}`))
  }
  if (warnings.length) {
    lines.push('', '### Warnings', ...warnings.map((warning) => `- ${warning}`))
  }
  return lines.join('\n') + '\n'
}

function main() {
  const raw = process.env.NEEDS_JSON
  if (!raw) {
    console.error('gate: NEEDS_JSON is not set')
    process.exit(1)
  }
  const verdict = evaluate(JSON.parse(raw), {
    artifacts: loadE2eArtifacts(process.env.GATE_E2E_DIR ?? 'gate-in'),
    planId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  })
  const summary = renderSummary(verdict)
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }
  for (const warning of verdict.warnings) {
    console.log(`::warning title=All Green advisory::${warning}`)
  }
  for (const failure of verdict.failures) {
    console.log(`::error title=All Green::${failure}`)
  }
  process.exit(verdict.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
