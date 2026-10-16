// Minimal glob matcher with picomatch `{ dot: true }` semantics, the options dorny/paths-filter
// uses. Supports `*`, `?`, `**`, `[...]`, `{a,b}`; anything else throws instead of guessing.

function expandBraces(pattern) {
  const open = pattern.indexOf('{')
  if (open === -1) {
    return [pattern]
  }
  let depth = 0
  let close = -1
  const commas = []
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    } else if (ch === ',' && depth === 1) {
      commas.push(i)
    }
  }
  if (close === -1) {
    throw new Error(`glob: unbalanced brace in "${pattern}"`)
  }
  const bounds = [open, ...commas, close]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const out = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const alt = pattern.slice(bounds[i] + 1, bounds[i + 1])
    if (/^-?\d+\.\.-?\d+$/.test(alt)) {
      throw new Error(`glob: brace ranges are not supported ("${pattern}")`)
    }
    out.push(...expandBraces(prefix + alt + suffix))
  }
  return out
}

function segmentToRegex(segment, pattern) {
  let re = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '*') {
      while (segment[i + 1] === '*') {
        i++
      }
      re += '[^/]*'
    } else if (ch === '?') {
      re += '[^/]'
    } else if (ch === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end === -1) {
        throw new Error(`glob: unterminated character class in "${pattern}"`)
      }
      let body = segment.slice(i + 1, end)
      if (body[0] === '!') {
        body = '^' + body.slice(1)
      }
      re += `[${body.replace(/\\/g, '\\\\')}]`
      i = end
    } else if (ch === '\\') {
      i++
      re += (segment[i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (ch === '(' || ch === ')' || ch === '|') {
      throw new Error(`glob: extglob/group syntax is not supported ("${pattern}")`)
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return re
}

function singleToRegex(pattern) {
  if (pattern.startsWith('!')) {
    throw new Error(`glob: negated patterns are not supported ("${pattern}")`)
  }
  const segments = pattern.split('/')
  let re = ''
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1
    if (segment === '**') {
      if (!last) {
        re += '(?:.*/)?'
      } else {
        re += i === 0 ? '.*' : '(?:/.*)?'
      }
      return
    }
    re += segmentToRegex(segment, pattern) + (last ? '' : '/')
  })
  return re.replace(/\/\(\?:\/\.\*\)\?$/, '(?:/.*)?')
}

export function globToRegExp(pattern) {
  const alternatives = expandBraces(pattern).map(singleToRegex)
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

export function createMatcher(patterns) {
  const regexes = patterns.map(globToRegExp)
  return (file) => regexes.some((re) => re.test(file))
}

export function isMatch(file, pattern) {
  return globToRegExp(pattern).test(file)
}
