#!/usr/bin/env node
// Decides the `All Green` verdict from `toJSON(needs)`. A required job that failed or was
// cancelled fails the gate, and so does one that was skipped although `changes` selected it.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const FAMILIES = ['needs_build', 'needs_tests', 'needs_visual', 'build_approvals', 'templates']

/**
 * `runs`: 'always' or the `changes` outputs that select the job (any one true selects it).
 * `advisory`: result is reported but never fails the gate, and a skip is not a defect.
 */
export const POLICY = {
  changes: { runs: 'always' },
  lint: { runs: 'always' },
  'int-matrix': { runs: 'always' },
  'e2e-matrix': { runs: 'always' },
  'pipeline-checks': { runs: 'always' },
  build: { runs: ['needs_build'] },
  'build-and-test-templates': { runs: ['needs_build', 'templates'] },
  'check-template-build-approvals': { runs: ['build_approvals'] },
  'probe-next-canary': { runs: ['needs_tests'] },
  'tests-unit': { runs: ['needs_tests', 'needs_visual'] },
  'tests-types': { runs: ['needs_tests'] },
  'tests-type-generation': { runs: ['needs_tests'] },
  'tests-int': { runs: ['needs_tests'] },
  'e2e-prep': { runs: ['needs_tests'] },
  'tests-e2e': { runs: ['needs_tests'] },
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
  'publish-canary': 'runs after the gate and depends on it',
}

const BAD = new Set(['failure', 'cancelled'])

export function evaluate(needs) {
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

  for (const [name, policy] of Object.entries(POLICY)) {
    const job = needs[name]
    if (!job) {
      failures.push(`${name}: missing from the gate's needs`)
      rows.push({ name, result: 'missing', verdict: 'FAIL', note: 'not wired into all-green' })
      continue
    }
    const result = job.result
    const expected = policy.runs === 'always' || policy.runs.some((family) => selected[family])
    let verdict = 'ok'
    let note = ''

    if (policy.advisory) {
      note = policy.advisory
      if (result === 'success') {
        verdict = 'advisory'
      } else if (result === 'skipped') {
        verdict = 'not run'
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

  return { ok: failures.length === 0, failures, warnings, rows, selected }
}

export function renderSummary({ ok, failures, warnings, rows, selected }) {
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
  const verdict = evaluate(JSON.parse(raw))
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
