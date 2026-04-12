#!/usr/bin/env node
'use strict';
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
// detect-cross-kit-collisions.cjs — CI quality gate
//
// Detects duplicate keywords, config keys, and agent names across kit roots.
//
// Detection:
//   1. Agent name collision (ERROR): same agent filename in different kit roots (file overwrite risk)
//   2. Keyword collision (WARNING):  same keyword maps to different skills in different kits
//                                    (acceptable due to additive merge, but worth flagging)
//
// Input:
//   arg 1: current kit root (defaults to cwd)
//   T1K_EXTERNAL_ROOTS env: space-separated paths to sibling kit roots for cross-kit comparison
//
// If no external roots provided, only internal collisions are checked (within current kit only).
// Internal agent collisions are impossible by definition, so this mode is effectively a no-op.
//
// Usage:
//   node scripts/detect-cross-kit-collisions.cjs [kit-root]
//   T1K_EXTERNAL_ROOTS="/path/to/theonekit-unity /path/to/theonekit-cocos" \
//     node scripts/detect-cross-kit-collisions.cjs /path/to/theonekit-core
//
// Exit 0 = no agent collisions (keyword collisions are warnings only)
// Exit 1 = agent name collision found between different kit roots
//
// Environment:
//   T1K_EXTERNAL_ROOTS    — space-separated sibling kit root paths
//   T1K_GATE_WARN_ONLY=1  — demote all errors to warnings (rollback mode)

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const WARN_ONLY = process.env.T1K_GATE_WARN_ONLY === '1';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Collection ────────────────────────────────────────────────────────────────

/**
 * Collect agent filenames (without .md extension) from a kit root.
 * Returns Map<agentName, absoluteFilePath>
 */
function collectAgents(kitRoot) {
  const agents    = new Map();
  const agentsDir = path.join(kitRoot, '.claude', 'agents');

  if (!fs.existsSync(agentsDir)) return agents;

  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name     = entry.slice(0, -3);  // strip .md
    const fullPath = path.join(agentsDir, entry);
    agents.set(name, fullPath);
  }

  return agents;
}

/**
 * Collect keyword→skill mappings from all t1k-activation-*.json fragments in a kit root.
 * Returns Map<keyword, { skill, kitRoot, fragmentFile }>
 * If a keyword maps to multiple skills in the SAME kit, only the first is stored
 * (same-kit multi-skill mappings are intentional and not flagged).
 */
function collectKeywordMappings(kitRoot) {
  const mappings  = new Map();
  const claudeDir = path.join(kitRoot, '.claude');

  if (!fs.existsSync(claudeDir)) return mappings;

  let claudeEntries;
  try {
    claudeEntries = fs.readdirSync(claudeDir);
  } catch {
    return mappings;
  }

  for (const entry of claudeEntries) {
    if (!entry.startsWith('t1k-activation-') || !entry.endsWith('.json')) continue;

    const filePath = path.join(claudeDir, entry);
    const data     = readJsonSafe(filePath);
    if (!data || !Array.isArray(data.mappings)) continue;

    for (const mapping of data.mappings) {
      if (!Array.isArray(mapping.keywords) || !Array.isArray(mapping.skills)) continue;
      for (const keyword of mapping.keywords) {
        if (typeof keyword !== 'string' || !keyword.trim()) continue;
        const kw = keyword.trim().toLowerCase();
        if (!mappings.has(kw)) {
          // Store the first skill from this mapping as representative
          const representativeSkill = mapping.skills[0] || '(unknown)';
          mappings.set(kw, { skill: representativeSkill, kitRoot, fragmentFile: entry });
        }
      }
    }
  }

  return mappings;
}

// ── Kit root resolution ───────────────────────────────────────────────────────

/**
 * Resolve all kit roots to compare: current kit + externals from env.
 * Falls back to auto-detecting theonekit-core as a sibling if no env set
 * and the current kit is not core itself.
 */
function resolveAllKitRoots(currentKitRoot) {
  const roots = [{ label: path.basename(currentKitRoot), root: currentKitRoot }];

  const envRoots = process.env.T1K_EXTERNAL_ROOTS;
  if (envRoots) {
    // Support colon-separated paths (like PATH env var convention) for paths with spaces.
    // Also accept newline-separated as a convenience.
    // Colon separator is preferred: T1K_EXTERNAL_ROOTS="/path/a:/path/b"
    const separator = envRoots.includes(':') ? ':' : '\n';
    for (const r of envRoots.split(separator).map(s => s.trim()).filter(Boolean)) {
      const resolved = path.resolve(r);
      if (resolved !== path.resolve(currentKitRoot)) {
        roots.push({ label: path.basename(resolved), root: resolved });
      }
    }
    return roots;
  }

  // Auto-detect sibling theonekit-core if not already on current kit
  const parentDir    = path.dirname(path.resolve(currentKitRoot));
  const siblingCore  = path.join(parentDir, 'theonekit-core');
  const kitName      = path.basename(path.resolve(currentKitRoot));

  if (kitName !== 'theonekit-core' && fs.existsSync(path.join(siblingCore, '.claude'))) {
    roots.push({ label: 'theonekit-core', root: siblingCore });
  }

  return roots;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const currentKitRoot = path.resolve(process.argv[2] || process.cwd());

  if (!fs.existsSync(path.join(currentKitRoot, '.claude'))) {
    console.log('[cross-kit] No .claude/ directory found — skipping');
    process.exit(0);
  }

  if (WARN_ONLY) {
    console.log('[cross-kit] WARN_ONLY mode active — errors will be emitted as warnings');
  }

  const allRoots = resolveAllKitRoots(currentKitRoot);

  if (allRoots.length < 2) {
    console.log(
      '[cross-kit] No external kit roots provided — only internal checks apply. ' +
      'Set T1K_EXTERNAL_ROOTS env var for cross-kit collision detection.'
    );
    process.exit(0);
  }

  console.log(`[cross-kit] Comparing ${allRoots.length} kit roots: ${allRoots.map(r => r.label).join(', ')}`);

  // ── Agent name collision detection ─────────────────────────────────────────
  // Map<agentName, { label, filePath }[]> — collect all occurrences across roots
  const agentOccurrences = new Map();

  for (const { label, root } of allRoots) {
    const agents = collectAgents(root);
    for (const [name, filePath] of agents) {
      if (!agentOccurrences.has(name)) agentOccurrences.set(name, []);
      agentOccurrences.get(name).push({ label, filePath });
    }
  }

  let agentErrors = 0;
  for (const [name, occurrences] of agentOccurrences) {
    // Only flag if the same agent appears in DIFFERENT kit roots
    const distinctRoots = new Set(occurrences.map(o => o.label));
    if (distinctRoots.size < 2) continue;

    const locations = occurrences.map(o => `${o.label}`).join(', ');
    // Use the first occurrence's file as the annotation target
    const relFile = path.relative(currentKitRoot, occurrences[0].filePath).split(path.sep).join('/');
    emitError(relFile, `Agent name collision: "${name}.md" exists in multiple kits (${locations}) — install will overwrite`);
    agentErrors++;
  }

  // ── Keyword collision detection ────────────────────────────────────────────
  // Map<keyword, { skill, kitRoot, fragmentFile, label }[]>
  const keywordOccurrences = new Map();

  for (const { label, root } of allRoots) {
    const mappings = collectKeywordMappings(root);
    for (const [keyword, { skill, fragmentFile }] of mappings) {
      if (!keywordOccurrences.has(keyword)) keywordOccurrences.set(keyword, []);
      keywordOccurrences.get(keyword).push({ skill, fragmentFile, label, root });
    }
  }

  let keywordWarnings = 0;
  for (const [keyword, occurrences] of keywordOccurrences) {
    // Only flag if same keyword maps to DIFFERENT skills in DIFFERENT kits
    const distinctPairs = new Set(occurrences.map(o => `${o.label}:${o.skill}`));
    if (distinctPairs.size < 2) continue;

    // Check if skills actually differ across kits (not just same skill in multiple kits)
    const distinctSkills = new Set(occurrences.map(o => o.skill));
    if (distinctSkills.size < 2) continue;

    const details = occurrences.map(o => `${o.label}→${o.skill}`).join(', ');
    // Find if any occurrence is in the current kit to anchor the annotation
    const localOccurrence = occurrences.find(o => path.resolve(o.root) === path.resolve(currentKitRoot));
    const relFile = localOccurrence
      ? path.join('.claude', localOccurrence.fragmentFile)
      : '.claude';
    emitWarning(relFile, `Keyword collision: "${keyword}" maps to different skills across kits (${details}) — additive merge applies but may cause confusion`);
    keywordWarnings++;
  }

  console.log(
    `[cross-kit] agent-collisions=${agentErrors} keyword-collisions=${keywordWarnings}`
  );

  if (agentErrors > 0 && !WARN_ONLY) {
    console.error(`[cross-kit] Validation failed: ${agentErrors} agent name collision(s) detected`);
    process.exit(1);
  }

  process.exit(0);
}

main();
