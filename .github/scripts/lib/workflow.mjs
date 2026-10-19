// Dependency-free readers for the two shapes of main.yml that the pipeline checks need: the job
// list with each job's `needs`, and the `dorny/paths-filter` filters block.

const stripComment = (line) => line.replace(/(^|\s)#.*$/, '')

export function parseJobs(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (start === -1) {
    throw new Error('workflow: no top-level `jobs:` key')
  }
  const jobs = new Map()
  let current = null
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !/^\s*#/.test(line)) {
      break
    }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line)
    if (header) {
      current = { name: header[1], lines: [] }
      jobs.set(current.name, current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  for (const job of jobs.values()) {
    job.needs = readNeeds(job.lines)
  }
  return jobs
}

function readNeeds(lines) {
  const index = lines.findIndex((line) => /^ {4}needs:/.test(line))
  if (index === -1) {
    return []
  }
  const collected = [lines[index].replace(/^ {4}needs:/, '')]
  for (const line of lines.slice(index + 1)) {
    if (/^ {4}\S/.test(line)) {
      break
    }
    collected.push(line)
  }
  return collected
    .map(stripComment)
    .join(' ')
    .split(/[\s,[\]]+/)
    .filter((token) => token && token !== '-')
}

export function parseFilters(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s+filters:\s*\|\s*$/.test(line))
  if (start === -1) {
    throw new Error('workflow: no `filters: |` block')
  }
  const baseIndent = lines[start].search(/\S/)
  const filters = {}
  let current = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= baseIndent) {
      break
    }
    const content = stripComment(line).trim()
    if (!content) {
      continue
    }
    const key = /^([A-Za-z0-9_-]+):$/.exec(content)
    if (key) {
      current = filters[key[1]] = []
      continue
    }
    const item = /^- ['"](.+)['"]$/.exec(content)
    if (!item || !current) {
      throw new Error(`workflow: unrecognised filters line "${content}"`)
    }
    current.push(item[1])
  }
  return filters
}
