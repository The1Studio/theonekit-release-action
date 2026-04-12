#!/usr/bin/env node
'use strict';
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
// validate-frontmatter.cjs — CI quality gate
//
// Validates required YAML frontmatter fields in SKILL.md and agent .md files.
//
// Scanned paths:
//   .claude/skills/*/SKILL.md
//   .claude/modules/*/skills/*/SKILL.md
//   .claude/agents/*.md
//
// SKILL required fields (ERROR):    name, description
// SKILL warned fields (WARNING):    effort (low|medium|high), keywords
// Agent required fields (ERROR):    name, description, model (inherit|sonnet|opus|haiku), maxTurns (1-100)
// Agent warned fields (WARNING):    roles
//
// CI-injected fields are skipped: origin, repository, module, protected
//
// Usage:
//   node scripts/validate-frontmatter.cjs [kit-root]
//   (defaults to cwd if no argument given)
//
// Exit 0 = valid (or warnings only)
// Exit 1 = required fields missing
//
// Environment:
//   T1K_GATE_WARN_ONLY=1  -- demote all errors to warnings (rollback mode)

const fs   = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const WARN_ONLY = process.env.T1K_GATE_WARN_ONLY === '1';

// Fields injected by CI/CD — never validate these
const CI_INJECTED_FIELDS = new Set(['origin', 'repository', 'module', 'protected']);

const VALID_EFFORT_VALUES  = new Set(['low', 'medium', 'high']);
const VALID_MODEL_VALUES   = new Set(['inherit', 'sonnet', 'opus', 'haiku']);

// ── File walking ─────────────────────────────────────────────────────────────

function findFiles(dir, predicate) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      results.push(...findFiles(full, predicate));
    } else if (predicate(entry, full)) {
      results.push(full);
    }
  }
  return results;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[frontmatter] warn: could not read ${filePath}: ${err.message}`);
    return null;
  }
}

// ── YAML frontmatter parsing ─────────────────────────────────────────────────

/**
 * Extract raw YAML frontmatter string from file content.
 * Returns null if no valid frontmatter block found.
 */
function extractFrontmatterBlock(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Parse a simple YAML frontmatter block into a key→value map.
 * Handles:
 *   - Scalar: key: value
 *   - Quoted: key: "value" or key: 'value'
 *   - Array (inline): key: [a, b, c]
 *   - Array (block): key:\n  - a\n  - b
 *   - Multiline scalar (|, >): captured as non-empty string
 *   - Skips CI-injected fields
 */
function parseFrontmatter(fm) {
  const fields = {};
  const lines  = fm.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i++;

    // Skip blank or comment lines
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Key: value
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key   = line.slice(0, colonIdx).trim();
    const after = line.slice(colonIdx + 1).trim();

    // Skip CI-injected fields
    if (CI_INJECTED_FIELDS.has(key)) continue;

    if (after === '' || after === '|' || after === '>') {
      // Multiline block — collect indented lines
      const indented = [];
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].startsWith('\t') || lines[i].trim() === '')) {
        const stripped = lines[i].trim();
        if (stripped) indented.push(stripped);
        i++;
      }
      fields[key] = indented.length > 0 ? indented.join(' ') : null;
    } else if (after.startsWith('[')) {
      // Inline array: [a, b, c]
      const inner = after.replace(/^\[/, '').replace(/\].*$/, '');
      const items = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      fields[key] = items.length > 0 ? items : [];
    } else {
      // Scalar (possibly quoted)
      const value = after.replace(/^['"]|['"]$/g, '').trim();
      fields[key] = value || null;
    }
  }

  return fields;
}

// ── Annotation helpers ───────────────────────────────────────────────────────

function sanitize(str) {
  return String(str)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function emitError(relFile, message) {
  const level = WARN_ONLY ? 'warning' : 'error';
  console.log(`::${level} file=${sanitize(relFile)}::${sanitize(message)}`);
}

function emitWarning(relFile, message) {
  console.log(`::warning file=${sanitize(relFile)}::${sanitize(message)}`);
}

// ── Validation logic ─────────────────────────────────────────────────────────

/**
 * Validate a SKILL.md file. Returns { errors, warnings } counts.
 */
function validateSkill(filePath, relFile) {
  const content = readFileSafe(filePath);
  if (!content) return { errors: 0, warnings: 0 };

  const fm = extractFrontmatterBlock(content);
  if (!fm) {
    emitError(relFile, 'Missing YAML frontmatter block (expected --- ... ---)');
    return { errors: 1, warnings: 0 };
  }

  const fields = parseFrontmatter(fm);
  let errors   = 0;
  let warnings = 0;

  // Required: name
  if (!fields.name) {
    emitError(relFile, 'SKILL.md missing required frontmatter field: name');
    errors++;
  }

  // Required: description
  if (!fields.description) {
    emitError(relFile, 'SKILL.md missing required frontmatter field: description');
    errors++;
  }

  // Warning: effort
  if (!fields.effort) {
    emitWarning(relFile, 'SKILL.md missing recommended frontmatter field: effort (expected: low, medium, or high)');
    warnings++;
  } else if (!VALID_EFFORT_VALUES.has(String(fields.effort).toLowerCase())) {
    emitWarning(relFile, `SKILL.md frontmatter "effort" has unexpected value "${fields.effort}" — expected: low, medium, high`);
    warnings++;
  }

  // Warning: keywords
  const hasKeywords = fields.keywords != null &&
    ((Array.isArray(fields.keywords) && fields.keywords.length > 0) ||
     (typeof fields.keywords === 'string' && fields.keywords.trim().length > 0));
  if (!hasKeywords) {
    emitWarning(relFile, 'SKILL.md missing recommended frontmatter field: keywords (expected array/list)');
    warnings++;
  }

  return { errors, warnings };
}

/**
 * Validate an agent .md file. Returns { errors, warnings } counts.
 */
function validateAgent(filePath, relFile) {
  const content = readFileSafe(filePath);
  if (!content) return { errors: 0, warnings: 0 };

  const fm = extractFrontmatterBlock(content);
  if (!fm) {
    emitError(relFile, 'Agent .md missing YAML frontmatter block (expected --- ... ---)');
    return { errors: 1, warnings: 0 };
  }

  const fields = parseFrontmatter(fm);
  let errors   = 0;
  let warnings = 0;

  // Required: name
  if (!fields.name) {
    emitError(relFile, 'Agent missing required frontmatter field: name');
    errors++;
  }

  // Required: description
  if (!fields.description) {
    emitError(relFile, 'Agent missing required frontmatter field: description');
    errors++;
  }

  // Required: model
  if (!fields.model) {
    emitError(relFile, 'Agent missing required frontmatter field: model (expected: inherit, sonnet, opus, or haiku)');
    errors++;
  } else if (!VALID_MODEL_VALUES.has(String(fields.model).toLowerCase())) {
    emitError(relFile, `Agent frontmatter "model" has unexpected value "${fields.model}" — expected: inherit, sonnet, opus, haiku`);
    errors++;
  }

  // Required: maxTurns
  if (fields.maxTurns == null) {
    emitError(relFile, 'Agent missing required frontmatter field: maxTurns (expected integer 1-100)');
    errors++;
  } else {
    const mt = parseInt(String(fields.maxTurns), 10);
    if (isNaN(mt) || mt < 1 || mt > 100) {
      emitError(relFile, `Agent frontmatter "maxTurns" value "${fields.maxTurns}" is invalid — expected integer between 1 and 100`);
      errors++;
    }
  }

  // Warning: roles
  const hasRoles = fields.roles != null &&
    ((Array.isArray(fields.roles) && fields.roles.length > 0) ||
     (typeof fields.roles === 'string' && fields.roles.trim().length > 0));
  if (!hasRoles) {
    emitWarning(relFile, 'Agent missing recommended frontmatter field: roles (expected array or "none")');
    warnings++;
  }

  return { errors, warnings };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const kitRoot  = path.resolve(process.argv[2] || process.cwd());
  const claudeDir = path.join(kitRoot, '.claude');

  if (!fs.existsSync(claudeDir)) {
    console.log('[frontmatter] No .claude/ directory found — skipping');
    process.exit(0);
  }

  if (WARN_ONLY) {
    console.log('[frontmatter] WARN_ONLY mode active — errors will be emitted as warnings');
  }

  let totalErrors   = 0;
  let totalWarnings = 0;
  let filesChecked  = 0;

  // 1. Scan .claude/skills/*/SKILL.md
  const skillsDir = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    const skillFiles = findFiles(skillsDir, (entry) => entry === 'SKILL.md');
    for (const f of skillFiles) {
      const relFile = path.relative(kitRoot, f).split(path.sep).join('/');
      const { errors, warnings } = validateSkill(f, relFile);
      totalErrors   += errors;
      totalWarnings += warnings;
      filesChecked++;
    }
  }

  // 2. Scan .claude/modules/*/skills/*/SKILL.md
  const modulesDir = path.join(claudeDir, 'modules');
  if (fs.existsSync(modulesDir)) {
    const moduleSkillFiles = findFiles(
      modulesDir,
      (entry) => entry === 'SKILL.md'
    );
    for (const f of moduleSkillFiles) {
      const relFile = path.relative(kitRoot, f).split(path.sep).join('/');
      const { errors, warnings } = validateSkill(f, relFile);
      totalErrors   += errors;
      totalWarnings += warnings;
      filesChecked++;
    }
  }

  // 3. Scan .claude/agents/*.md
  const agentsDir = path.join(claudeDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    let agentEntries;
    try {
      agentEntries = fs.readdirSync(agentsDir);
    } catch {
      agentEntries = [];
    }
    for (const entry of agentEntries) {
      if (!entry.endsWith('.md')) continue;
      const f       = path.join(agentsDir, entry);
      const relFile = path.relative(kitRoot, f).split(path.sep).join('/');
      const { errors, warnings } = validateAgent(f, relFile);
      totalErrors   += errors;
      totalWarnings += warnings;
      filesChecked++;
    }
  }

  console.log(
    `[frontmatter] files=${filesChecked} errors=${totalErrors} warnings=${totalWarnings}`
  );

  if (totalErrors > 0 && !WARN_ONLY) {
    console.error(`[frontmatter] Validation failed with ${totalErrors} error(s)`);
    process.exit(1);
  }

  process.exit(0);
}

main();
