import { readdirSync } from 'node:fs'
import path from 'node:path'

const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
])

/** Every file under `root` as a posix path relative to it, skipping build/vendor directories. */
export function walk(root, relative = '') {
  const results = []
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results.push(...walk(root, relative ? `${relative}/${entry.name}` : entry.name))
      }
    } else if (entry.isFile()) {
      results.push(relative ? `${relative}/${entry.name}` : entry.name)
    }
  }
  return results
}
