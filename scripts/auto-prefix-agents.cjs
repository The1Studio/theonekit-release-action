/**
 * auto-prefix-agents.cjs
 * Auto-prefix agent filenames for uniqueness across kits/modules.
 *
 * Naming formula:
 *   Core agents:       no prefix (base layer — core is never prefixed)
 *   Kit-wide agents:   {kit-short}-{basename}
 *   Module agents:     {kit-short}-{module}-{basename}
 *
 * Skip logic: if filename already starts with the expected prefix, skip.
 *
 * Also updates:
 *   - `name:` field in agent frontmatter
 *   - `agents` arrays in t1k-modules.json module entries
 *   - Agent references in routing overlay JSON files
 *
 * Env:
 *   GITHUB_REPO   — owner/repo for kit-short derivation (e.g. "The1Studio/theonekit-unity")
 *   MODULES_FILE  — path to t1k-modules.json (optional for flat kits)
 *   CORE_REPO     — core repo name (default: "theonekit-core") — core is never prefixed
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = process.cwd();
const CLAUDE_DIR  = path.join(ROOT, '.claude');
const AGENTS_DIR  = path.join(CLAUDE_DIR, 'agents');

const GITHUB_REPO = process.env.GITHUB_REPO || '';
const CORE_REPO   = process.env.CORE_REPO   || 'theonekit-core';
const MODULES_FILE = process.env.MODULES_FILE || '';

// Derive kit-short: "theonekit-unity" -> "unity", "theonekit-core" -> "core"
const KIT_NAME    = GITHUB_REPO.split('/').pop() || path.basename(ROOT);
const KIT_SHORT   = KIT_NAME.replace(/^theonekit-/, '');

if (!fs.existsSync(AGENTS_DIR)) {
  console.log('[prefix] No .claude/agents/ directory — nothing to do');
  process.exit(0);
}

// Core is never prefixed
if (KIT_NAME === CORE_REPO || KIT_SHORT === 'core') {
  console.log('[prefix] Core kit — skipping agent prefixing');
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build agent→module map from t1k-modules.json.
 * Returns: Map<agentFilename, moduleName>
 */
function buildAgentModuleMap(modulesFilePath) {
  const map = new Map();
  if (!modulesFilePath || !fs.existsSync(modulesFilePath)) return map;

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(modulesFilePath, 'utf8'));
  } catch (e) {
    console.warn(`[prefix] warn: could not parse ${modulesFilePath}: ${e.message}`);
    return map;
  }

  for (const [moduleName, mod] of Object.entries(registry.modules || {})) {
    for (const agentFile of (mod.agents || [])) {
      map.set(agentFile, moduleName);
    }
  }
  return map;
}

/**
 * Resolve the modules file path.
 */
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
 * Read and update the `name:` field in agent YAML frontmatter.
 * Returns the updated file content (does not write to disk).
 * Throws if frontmatter is malformed.
 */
function updateAgentName(content, newName) {
  if (!content.startsWith('---\n')) {
    throw new Error('Agent file missing YAML frontmatter (must start with ---)');
  }

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    throw new Error('Agent file has unclosed YAML frontmatter');
  }

  const fmBlock = content.substring(4, endIdx);
  const body    = content.substring(endIdx + 5);

  const updatedLines = fmBlock.split('\n').map(line => {
    if (/^name:\s/.test(line) || line === 'name:') {
      return `name: ${newName}`;
    }
    return line;
  });

  // If name field was not found, insert it at the top of the frontmatter
  const hasName = fmBlock.split('\n').some(l => /^name:/.test(l));
  if (!hasName) {
    updatedLines.unshift(`name: ${newName}`);
  }

  return `---\n${updatedLines.join('\n')}\n---\n${body}`;
}

/**
 * Validate agent frontmatter has required fields.
 * Throws with a clear message on failure.
 */
function validateAgentFrontmatter(content, filePath) {
  if (!content.startsWith('---\n')) {
    throw new Error(`[prefix] ${filePath}: missing YAML frontmatter`);
  }
  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    throw new Error(`[prefix] ${filePath}: unclosed YAML frontmatter`);
  }
  const fm = content.substring(4, endIdx);
  const required = ['name', 'model', 'maxTurns'];
  for (const field of required) {
    if (!new RegExp(`^${field}:`, 'm').test(fm)) {
      throw new Error(`[prefix] ${filePath}: frontmatter missing required field "${field}"`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const modulesFilePath = resolveModulesFile();
const agentModuleMap  = buildAgentModuleMap(modulesFilePath);

if (modulesFilePath) {
  console.log(`[prefix] Module map loaded from ${modulesFilePath} (${agentModuleMap.size} agent(s))`);
} else {
  console.log('[prefix] No t1k-modules.json found — treating all agents as kit-wide');
}

const renames = []; // [{ oldFile, newFile, oldName, newName }]

const agentFiles = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.md'))
  .sort();

for (const filename of agentFiles) {
  const filePath = path.join(AGENTS_DIR, filename);
  const basename = filename.replace(/\.md$/, '');

  // Determine module ownership
  const moduleName = agentModuleMap.get(filename) || null;

  // Compute expected prefix
  const expectedPrefix = moduleName
    ? `${KIT_SHORT}-${moduleName}-`
    : `${KIT_SHORT}-`;

  // Skip if already correctly prefixed
  if (basename.startsWith(expectedPrefix)) {
    console.log(`[prefix] skip: ${filename} (already prefixed)`);
    continue;
  }

  // Compute new filename
  const newBasename = `${expectedPrefix}${basename}`;
  const newFilename = `${newBasename}.md`;
  const newFilePath = path.join(AGENTS_DIR, newFilename);

  // Read, validate, update frontmatter name
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
    validateAgentFrontmatter(content, filename);
    content = updateAgentName(content, newBasename);
  } catch (err) {
    throw new Error(`[prefix] Failed to process ${filename}: ${err.message}`);
  }

  // Write updated content to new path
  fs.writeFileSync(newFilePath, content);
  fs.unlinkSync(filePath);

  renames.push({ oldFile: filename, newFile: newFilename, oldName: basename, newName: newBasename });
  console.log(`[prefix] renamed: ${filename} -> ${newFilename}`);
}

if (renames.length === 0) {
  console.log('[prefix] No renames needed — all agents already correctly prefixed');
  process.exit(0);
}

// ── Update t1k-modules.json agent arrays ─────────────────────────────────────

if (modulesFilePath && fs.existsSync(modulesFilePath)) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(modulesFilePath, 'utf8'));
  } catch (e) {
    throw new Error(`[prefix] Cannot update ${modulesFilePath}: ${e.message}`);
  }

  const renameMap = new Map(renames.map(r => [r.oldFile, r.newFile]));
  let changed = false;

  for (const mod of Object.values(registry.modules || {})) {
    if (!Array.isArray(mod.agents)) continue;
    const updated = mod.agents.map(a => renameMap.get(a) || a);
    if (updated.some((v, i) => v !== mod.agents[i])) {
      mod.agents = updated;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(modulesFilePath, JSON.stringify(registry, null, 2) + '\n');
    console.log(`[prefix] Updated agent references in ${path.relative(ROOT, modulesFilePath)}`);
  }
}

// ── Update routing overlay JSON files ────────────────────────────────────────

const renameMap = new Map(renames.map(r => [r.oldName, r.newName]));

const overlayPattern = /^t1k-routing-.+\.json$/;
const claudeFiles = fs.readdirSync(CLAUDE_DIR).filter(f => overlayPattern.test(f));

for (const overlayFile of claudeFiles) {
  const overlayPath = path.join(CLAUDE_DIR, overlayFile);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  } catch {
    continue; // skip malformed JSON overlays
  }

  let changed = false;

  // Update all string values in the routing object that match old agent names
  function updateObj(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && renameMap.has(v)) {
        obj[k] = renameMap.get(v);
        changed = true;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        updateObj(v);
      }
    }
  }

  updateObj(data);

  if (changed) {
    fs.writeFileSync(overlayPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`[prefix] Updated routing references in ${overlayFile}`);
  }
}

console.log(`\n[prefix] Done — ${renames.length} agent(s) renamed`);
