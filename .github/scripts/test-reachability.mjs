#!/usr/bin/env node
// Every spec file must be run by a main.yml job or be listed in test-reachability-exclusions.json.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMatcher } from './lib/glob.mjs'
import { walk } from './lib/walk.mjs'
import { parseJobs } from './lib/workflow.mjs'
import { findVisualSuites } from './visual/find-visual-suites.mjs'

export const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/

function globRule(job, via, include, exclude = [], sources = []) {
  const included = createMatcher(include)
  const excluded = createMatcher(exclude)
  return { job, via, matches: (file) => included(file) && !excluded(file), sources }
}

const VITEST_CONFIG = 'vitest.config.ts'
const MAIN_YML = '.github/workflows/main.yml'

/** Static rules; each `sources` entry is checked against the real file so the rule cannot drift. */
export function staticRules(tstycheGlobs) {
  const unitGlobs = [
    'packages/**/*.spec.ts',
    'tools/**/*.spec.ts',
    'test/**/*.unit.spec.ts',
    '.github/scripts/**/*.spec.mjs',
  ]
  return [
    globRule(
      'tests-unit',
      'vitest project unit (pnpm test:unit)',
      unitGlobs,
      ['**/*.rsc.spec.ts'],
      [
        {
          file: VITEST_CONFIG,
          includes: [...unitGlobs.map((glob) => `'${glob}'`), "name: 'unit'"],
        },
        { file: MAIN_YML, includes: ['pnpm test:unit'] },
        { file: 'package.json', includes: ['vitest run --project unit', 'pnpm test:rsc'] },
      ],
    ),
    globRule(
      'tests-unit',
      'vitest project rsc (pnpm test:unit, test:rsc)',
      ['packages/next/**/*.rsc.spec.ts'],
      [],
      [
        { file: VITEST_CONFIG, includes: ["'packages/next/**/*.rsc.spec.ts'", "name: 'rsc'"] },
        { file: 'package.json', includes: ['vitest run --project rsc'] },
      ],
    ),
    globRule(
      'tests-unit',
      'vitest project components (pnpm test:components)',
      ['packages/**/*.spec.tsx'],
      [],
      [
        { file: VITEST_CONFIG, includes: ["'packages/**/*.spec.tsx'", "name: 'components'"] },
        { file: MAIN_YML, includes: ['pnpm test:components'] },
        { file: 'package.json', includes: ['vitest run --project components'] },
      ],
    ),
    globRule(
      'tests-int',
      'vitest project int (pnpm test:int)',
      ['test/**/*int.spec.ts'],
      [],
      [
        { file: VITEST_CONFIG, includes: ["'test/**/*int.spec.ts'", "name: 'int'"] },
        { file: MAIN_YML, includes: ['pnpm test:int --shard='] },
        { file: 'package.json', includes: ['vitest --project int'] },
      ],
    ),
    globRule(
      'tests-types',
      'tstyche (pnpm test:types)',
      tstycheGlobs,
      [],
      [
        { file: MAIN_YML, includes: ['pnpm test:types'] },
        { file: 'package.json', includes: ['"test:types": "tstyche"'] },
      ],
    ),
    globRule(
      'pipeline-checks',
      'node --test of the pipeline scripts',
      ['.github/scripts/**/*.test.mjs'],
      [],
      [{ file: MAIN_YML, includes: ["node --test '.github/scripts/**/*.test.mjs'"] }],
    ),
  ]
}

/** `<suite>` as run by test/runE2E.ts: `__` is a path separator, `#config` selects a config. */
const suiteDirectory = (suite) => `test/${suite.split('#')[0].replaceAll('__', '/')}/`

function suiteRule(job, via, suites, sources) {
  const directories = [...new Set(suites.map(suiteDirectory))]
  return {
    job,
    via,
    matches: (file) =>
      directories.some((dir) => {
        const rest = file.startsWith(dir) ? file.slice(dir.length) : null
        return rest !== null && !rest.includes('/') && rest.endsWith('e2e.spec.ts')
      }),
    sources,
  }
}

export function buildRules({ matrixSuites, visualSuites, templates, tstycheGlobs }) {
  return [
    ...staticRules(tstycheGlobs),
    suiteRule('tests-e2e', 'e2e.config.ts matrix, runE2E.ts *e2e.spec.ts', matrixSuites, [
      { file: 'test/runE2E.ts', includes: ["'*e2e.spec.ts'"] },
      { file: MAIN_YML, includes: ['pnpm test:e2e:prod:server:run:noturbo ${{ matrix.suite }}'] },
    ]),
    suiteRule('visual-regression', 'find-visual-suites.mjs suites', visualSuites, [
      { file: '.github/scripts/visual/run-visual-suites.sh', includes: ['find-visual-suites.mjs'] },
      { file: MAIN_YML, includes: ['run-visual-suites.sh'] },
    ]),
    {
      job: 'build-and-test-templates',
      via: 'main.yml template matrix (test:int and test:e2e)',
      matches: (file) => templates.some((template) => file.startsWith(`templates/${template}/`)),
      sources: [
        { file: MAIN_YML, includes: ['pnpm --filter ${{ matrix.template }} run test:int'] },
      ],
    },
  ]
}

export function checkRuleSources(root, rules) {
  const problems = []
  const jobs = parseJobs(readFileSync(path.join(root, MAIN_YML), 'utf8'))
  for (const rule of rules) {
    if (!jobs.has(rule.job)) {
      problems.push(`rule "${rule.via}": job "${rule.job}" is not in main.yml`)
    }
    for (const { file, includes } of rule.sources) {
      const full = path.join(root, file)
      const text = existsSync(full) ? readFileSync(full, 'utf8') : null
      for (const needle of includes) {
        if (text === null || !text.includes(needle)) {
          problems.push(`rule "${rule.via}": ${file} no longer contains ${JSON.stringify(needle)}`)
        }
      }
    }
  }
  return problems
}

/** Pure core: which job(s) run each spec file, and what problems the exclusion list has. */
export function analyze({ files, rules, exclusions }) {
  const specs = files.filter((file) => SPEC_FILE.test(file)).sort()
  const coveredBy = new Map()
  const uncovered = []
  for (const spec of specs) {
    const jobs = rules.filter((rule) => rule.matches(spec)).map((rule) => rule.job)
    if (jobs.length) {
      coveredBy.set(spec, [...new Set(jobs)])
    } else {
      uncovered.push(spec)
    }
  }

  const problems = []
  const listed = new Map()
  for (const entry of exclusions) {
    if (typeof entry.path !== 'string' || !entry.path) {
      problems.push(`exclusion without a path: ${JSON.stringify(entry)}`)
    } else if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      problems.push(`exclusion without a reason: ${entry.path}`)
    } else if (listed.has(entry.path)) {
      problems.push(`exclusion listed twice: ${entry.path}`)
    } else {
      listed.set(entry.path, entry.reason)
    }
  }

  const unlisted = uncovered.filter((file) => !listed.has(file))
  for (const file of unlisted) {
    problems.push(`not run by any job and not in the exclusion list: ${file}`)
  }
  for (const file of listed.keys()) {
    if (coveredBy.has(file)) {
      problems.push(
        `excluded but now run by ${coveredBy.get(file).join(', ')}, remove the entry: ${file}`,
      )
    } else if (!specs.includes(file)) {
      problems.push(`excluded path no longer exists as a spec file, remove the entry: ${file}`)
    }
  }
  return { specs, coveredBy, uncovered, unlisted, problems }
}

function loadMatrixSuites(root) {
  const config = path.join(root, '.github/workflows/e2e.config.ts')
  const run = spawnSync(process.execPath, [config], { encoding: 'utf8', cwd: root })
  if (run.status !== 0) {
    throw new Error(`could not generate the E2E matrix from ${config}: ${run.stderr || run.error}`)
  }
  return [...new Set(JSON.parse(run.stdout).include.map((entry) => entry.suite))]
}

function loadTemplates(root) {
  const text = readFileSync(path.join(root, MAIN_YML), 'utf8')
  const block = text.slice(text.indexOf('build-and-test-templates:'))
  const matrix = block.slice(0, block.indexOf('steps:'))
  return [...matrix.matchAll(/^\s*-?\s*template:\s*([\w-]+)\s*$/gm)].map((m) => m[1])
}

export function collect(root) {
  const tstyche = JSON.parse(readFileSync(path.join(root, 'tstyche.json'), 'utf8'))
  const rules = buildRules({
    matrixSuites: loadMatrixSuites(root),
    visualSuites: findVisualSuites(path.join(root, 'test')),
    templates: loadTemplates(root),
    tstycheGlobs: tstyche.testFileMatch,
  })
  return { files: walk(root), rules }
}

export function renderSummary({ specs, coveredBy, uncovered, problems }, exclusionCount) {
  const perJob = new Map()
  for (const jobs of coveredBy.values()) {
    for (const job of jobs) {
      perJob.set(job, (perJob.get(job) ?? 0) + 1)
    }
  }
  const lines = [
    `## Test reachability: ${problems.length ? 'FAIL' : 'PASS'}`,
    '',
    `${specs.length} spec files: ${coveredBy.size} run by a job, ${uncovered.length} not run (${exclusionCount} listed with a reason).`,
    '',
    '| job | spec files |',
    '| --- | --- |',
    ...[...perJob].sort().map(([job, count]) => `| ${job} | ${count} |`),
  ]
  if (problems.length) {
    lines.push('', '### Problems', ...problems.map((problem) => `- ${problem}`))
  }
  return lines.join('\n') + '\n'
}

function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const root = path.resolve(option('--root') ?? path.join(import.meta.dirname, '../..'))
  const exclusionsFile = path.resolve(
    option('--exclusions') ?? path.join(root, '.github/test-reachability-exclusions.json'),
  )

  const { files, rules } = collect(root)
  const sourceProblems = checkRuleSources(root, rules)

  if (args.includes('--print-uncovered')) {
    const { uncovered } = analyze({ files, rules, exclusions: [] })
    const reason = 'not run by upstream CI at 73d3dd8; status unknown'
    console.log(
      JSON.stringify(
        uncovered.map((file) => ({ path: file, reason })),
        null,
        2,
      ),
    )
    return
  }

  const exclusions = existsSync(exclusionsFile)
    ? JSON.parse(readFileSync(exclusionsFile, 'utf8'))
    : []
  const result = analyze({ files, rules, exclusions })
  result.problems.unshift(...sourceProblems)

  const summary = renderSummary(result, exclusions.length)
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }
  for (const problem of result.problems) {
    console.log(`::error title=Test reachability::${problem}`)
  }
  process.exit(result.problems.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
