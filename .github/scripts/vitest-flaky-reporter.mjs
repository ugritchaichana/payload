// Writes retried-then-passed tests to $VITEST_FLAKY_DIR (vitest's json reporter omits retry counts).

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default class FlakyReporter {
  onInit(vitest) {
    this.root = vitest.config.root
  }

  onTestRunEnd(testModules) {
    const directory = process.env.VITEST_FLAKY_DIR
    if (!directory) {
      return
    }
    const flaky = []
    let executed = 0
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        const diagnostic = test.diagnostic()
        executed++
        if (diagnostic?.flaky) {
          flaky.push({
            file: path.relative(this.root, testModule.moduleId).split(path.sep).join('/'),
            project: test.project.name,
            retries: diagnostic.retryCount,
            title: test.fullName,
          })
        }
      }
    }
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      path.join(directory, `vitest-flaky-${process.pid}.json`),
      JSON.stringify({ executed, flaky, kind: 'vitest' }),
    )
  }
}
