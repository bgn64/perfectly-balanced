import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function fail(message) {
  throw new Error(message)
}

function readFrontmatter(path) {
  const text = readFileSync(path, 'utf8')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)

  if (!match) {
    fail(`${path}: missing YAML frontmatter`)
  }

  return match[1]
}

function frontmatterValue(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/u)
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index === -1) {
    return null
  }

  const rawValue = lines[index].slice(key.length + 1).trim()
  if (/^[>|][+-]?$/u.test(rawValue)) {
    const block = []
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/u.test(line)) {
        break
      }
      block.push(line.trim())
    }
    return block.join(' ').trim() || null
  }

  return rawValue.replace(/^(['"])(.*)\1$/u, '$2') || null
}

function requireDescription(path, frontmatter) {
  const description = frontmatterValue(frontmatter, 'description')
  if (!description) {
    fail(`${path}: description is required for discovery`)
  }
  return description
}

if (!existsSync('AGENTS.md')) {
  fail('AGENTS.md is required')
}

if (readFileSync('CLAUDE.md', 'utf8').trim() !== '@AGENTS.md') {
  fail('CLAUDE.md must contain exactly @AGENTS.md')
}

const skillRoot = join('.github', 'skills')
const skillDirectories = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())

for (const entry of skillDirectories) {
  const path = join(skillRoot, entry.name, 'SKILL.md')
  if (!existsSync(path)) {
    fail(`${dirname(path)}: SKILL.md is required`)
  }

  const frontmatter = readFrontmatter(path)
  const name = frontmatterValue(frontmatter, 'name')
  if (name !== basename(dirname(path))) {
    fail(`${path}: name must match its parent folder`)
  }
  const description = requireDescription(path, frontmatter)
  if (!/\buse (?:for|when|before)\b/iu.test(description)) {
    fail(`${path}: description must include an explicit discovery trigger`)
  }
}

const instructionRoot = join('.github', 'instructions')
const instructionFiles = readdirSync(instructionRoot)
  .filter((name) => name.endsWith('.instructions.md'))

for (const name of instructionFiles) {
  const path = join(instructionRoot, name)
  const frontmatter = readFrontmatter(path)
  if (!frontmatterValue(frontmatter, 'applyTo')) {
    fail(`${path}: applyTo is required`)
  }
  requireDescription(path, frontmatter)
}

console.log(
  `Validated ${skillDirectories.length} skills and ${instructionFiles.length} scoped instructions.`,
)