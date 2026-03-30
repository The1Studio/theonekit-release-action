/**
 * validate-no-collisions.cjs
 * Self-validation: naming and format within the kit itself.
 *
 * Validation rules:
 *   1. All agents must have correct prefix ({kit-short}- or {kit-short}-{module}-)
 *      unless this is the core kit (never prefixed).
 *   2. No two modules within the same kit have same-named agents/skills/rules.
 *   3. All .md agent files must have valid frontmatter with name, model, maxTurns.
 *
 * On failure: throw with clear message — NEVER silent fallback.
 *
 * Env:
 *   GITHUB_REPO   — owner/repo (e.g. "The1Studio/theonekit-unity")
 *   MODULES_FILE  — path to t1k-modules.json (optional for flat kits)
 *   CORE_REPO     — core repo name (default: "theonekit-core")
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = process.cwd();
const CLAUDE_DIR  = path.join(ROOT, '.claude');
const AGENTS_DIR  = path.join(CLAUDE_DIR, 'agents');

const GITHUB_REPO  = process.env.GITHUB_REPO  || '';
const CORE_REPO    = process.env.CORE_REPO    || 'theonekit-core';
const MODULES_FILE = process.env.MODULES_FILE || '';

const KIT_NAME  = GITHUB_REPO.split('/').pop() || path.basename(ROOT);
const KIT_SHORT = KIT_NAME.replace(/^theonekit-/, '');
const IS_CORE   = KIT_NAME === CORE_REPO || KIT_SHORT === 'core';

// Files that are shared/merge targets — skip collision checks for these
const MERGE_TARGETS = new Set([
  'metadata.json',
  't1k-modules.json',
  'settings.json',
  'CLAUDE.md',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveModulesFile() {
  if (MODULES_FILE) {
    return path.isAbsolute(MODULES_FILE) ? MODULES_FILE : path.join(ROOT, MODULES_FILE);
  }
  const candidates = [
    path.join(CLAUDE_DIR, 't1k-modules.json'),
    path.join(ROOT, 't1k-modules.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Parse YAML frontmatter fields (name, model, maxTurns) from agent .md content.
 * Returns { name, model, maxTurns } with null for missing fields.
 */
function parseAgentFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return null;

  const fm = content.substring(4, endIdx);
  const get = key => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };

  return {
    name:     get('name'),
    model:    get('model'),
    maxTurns: get('maxTurns'),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

const errors = [];

function fail(msg) {
  errors.push(msg);
}

// Load registry
const modulesFilePath = resolveModulesFile();
let registry = null;

if (modulesFilePath && fs.existsSync(modulesFilePath)) {
  try {
    registry = JSON.parse(fs.readFileSync(modulesFilePath, 'utf8'));
  } catch (e) {
    throw new Error(`[validate] Cannot parse ${modulesFilePath}: ${e.message}`);
  }
}

// Build agent→module map
const agentModuleMap = new Map(); // agentFilename -> moduleName
if (registry) {
  for (const [modName, mod] of Object.entries(registry.modules || {})) {
    for (const agentFile of (mod.agents || [])) {
      agentModuleMap.set(agentFile, modName);
    }
  }
}

// ── Rule 1: Agent prefix validation ──────────────────────────────────────────

if (!IS_CORE && fs.existsSync(AGENTS_DIR)) {
  const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));

  for (const filename of agentFiles) {
    const basename = filename.replace(/\.md$/, '');
    const moduleName = agentModuleMap.get(filename) || null;

    const expectedPrefix = moduleName
      ? `${KIT_SHORT}-${moduleName}-`
      : `${KIT_SHORT}-`;

    if (!basename.startsWith(expectedPrefix)) {
      fail(`Rule 1: Agent "${filename}" must be prefixed with "${expectedPrefix}" (got: "${basename}")`);
    }
  }
}

// ── Rule 2: No cross-module collisions ───────────────────────────────────────

if (registry) {
  const modules = registry.modules || {};

  // Agents collision check
  const agentSeen = new Map(); // agentBasename -> firstModuleName
  for (const [modName, mod] of Object.entries(modules)) {
    for (const agentFile of (mod.agents || [])) {
      if (MERGE_TARGETS.has(agentFile)) continue;
      const basename = agentFile.replace(/\.md$/, '');
      if (agentSeen.has(basename)) {
        fail(`Rule 2: Agent "${basename}" defined in both "${agentSeen.get(basename)}" and "${modName}"`);
      } else {
        agentSeen.set(basename, modName);
      }
    }
  }

  // Skills collision check
  const skillSeen = new Map(); // skillName -> firstModuleName
  for (const [modName, mod] of Object.entries(modules)) {
    for (const skillName of (mod.skills || [])) {
      if (skillSeen.has(skillName)) {
        fail(`Rule 2: Skill "${skillName}" defined in both "${skillSeen.get(skillName)}" and "${modName}"`);
      } else {
        skillSeen.set(skillName, modName);
      }
    }
  }

  // Rules collision check (if module declares rules)
  const ruleSeen = new Map();
  for (const [modName, mod] of Object.entries(modules)) {
    for (const ruleName of (mod.rules || [])) {
      if (MERGE_TARGETS.has(ruleName)) continue;
      if (ruleSeen.has(ruleName)) {
        fail(`Rule 2: Rule "${ruleName}" defined in both "${ruleSeen.get(ruleName)}" and "${modName}"`);
      } else {
        ruleSeen.set(ruleName, modName);
      }
    }
  }
}

// ── Rule 3: Agent frontmatter validation ─────────────────────────────────────

if (fs.existsSync(AGENTS_DIR)) {
  const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));

  for (const filename of agentFiles) {
    const filePath = path.join(AGENTS_DIR, filename);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      fail(`Rule 3: Cannot read agent file "${filename}": ${e.message}`);
      continue;
    }

    const fm = parseAgentFrontmatter(content);
    if (!fm) {
      fail(`Rule 3: Agent "${filename}" has no valid YAML frontmatter (must start with ---)`);
      continue;
    }

    if (!fm.name)     fail(`Rule 3: Agent "${filename}" frontmatter missing "name:"`);
    if (!fm.model)    fail(`Rule 3: Agent "${filename}" frontmatter missing "model:"`);
    if (!fm.maxTurns) fail(`Rule 3: Agent "${filename}" frontmatter missing "maxTurns:"`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`\n[validate] FAILED — ${errors.length} error(s):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  throw new Error(`[validate] Collision/format validation failed with ${errors.length} error(s). Fix the above before release.`);
}

console.log(`[validate] OK — no collisions or format errors detected`);
if (!IS_CORE) {
  console.log(`[validate] Kit: ${KIT_NAME} (short: ${KIT_SHORT})`);
}
