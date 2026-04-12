/**
 * post-release-smoke-test.cjs
 * Validate a downloaded release is structurally correct.
 *
 * Usage:
 *   node post-release-smoke-test.cjs <release-dir> <release-tag>
 *
 * Env:
 *   MODULAR       — set to "true" for modular kits
 *   MANIFEST_PATH — path to manifest.json (modular kits only)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Input ────────────────────────────────────────────────────────────────────

const releaseDir  = process.argv[2];
const releaseTag  = process.argv[3];
const isModular   = process.env.MODULAR === 'true';
const manifestPath = process.env.MANIFEST_PATH || '';

if (!releaseDir || !releaseTag) {
  console.error('[smoke-test] Usage: node post-release-smoke-test.cjs <release-dir> <release-tag>');
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  console.error(`[smoke-test] Release directory not found: ${releaseDir}`);
  process.exit(1);
}

const claudeDir = path.join(releaseDir, '.claude');

// ── Check helpers ─────────────────────────────────────────────────────────────

/**
 * Read and return parsed metadata.json. Returns null on failure.
 */
function readMetadata() {
  const p = path.join(claudeDir, 'metadata.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse a release tag to extract a version string.
 * Handles: "v1.56.0" → "1.56.0", "modules-20260412-1400" → null (no version).
 */
function parseVersionFromTag(tag) {
  const vMatch = tag.match(/^v?(\d+\.\d+\.\d+)/);
  return vMatch ? vMatch[1] : null;
}

// ── Checks ───────────────────────────────────────────────────────────────────

function checkMetadataExists() {
  const p = path.join(claudeDir, 'metadata.json');
  if (!fs.existsSync(p)) {
    return { pass: false, reason: `metadata.json not found at ${p}` };
  }
  return { pass: true };
}

function checkMetadataValidJson() {
  const meta = readMetadata();
  if (!meta) {
    return { pass: false, reason: 'metadata.json is missing or not valid JSON' };
  }
  const missing = ['name', 'version', 'buildDate'].filter(k => !meta[k]);
  if (missing.length > 0) {
    return { pass: false, reason: `metadata.json missing required fields: ${missing.join(', ')}` };
  }
  return { pass: true };
}

function checkVersionMatchesTag() {
  const tagVersion = parseVersionFromTag(releaseTag);
  if (!tagVersion) {
    // Modular tags (modules-YYYYMMDD-HHMM) don't embed a single version
    return { pass: true, note: `tag "${releaseTag}" has no single version — skip version match` };
  }
  const meta = readMetadata();
  if (!meta) {
    return { pass: false, reason: 'cannot read metadata.json to compare version' };
  }
  if (meta.version !== tagVersion) {
    return { pass: false, reason: `metadata.version "${meta.version}" does not match tag version "${tagVersion}"` };
  }
  return { pass: true };
}

function checkBuildDateRecent() {
  const meta = readMetadata();
  if (!meta || !meta.buildDate) {
    return { pass: false, reason: 'metadata.json missing buildDate' };
  }
  const buildDate = new Date(meta.buildDate);
  if (isNaN(buildDate.getTime())) {
    return { pass: false, reason: `buildDate "${meta.buildDate}" is not a valid ISO date` };
  }
  const ageMs = Date.now() - buildDate.getTime();
  const hours = ageMs / (1000 * 60 * 60);
  if (hours > 24) {
    return { pass: false, reason: `buildDate is ${hours.toFixed(1)}h old (> 24h threshold)` };
  }
  return { pass: true };
}

function checkSettingsValid() {
  const p = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(p)) {
    return { pass: false, reason: `settings.json not found at ${p}` };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { pass: false, reason: `settings.json is not valid JSON: ${e.message}` };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { pass: false, reason: 'settings.json missing "hooks" object' };
  }
  return { pass: true };
}

function checkSkillsHaveSkillMd() {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    // Not all kits have a skills directory — soft pass
    return { pass: true, note: 'no skills/ directory found — skipping' };
  }
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  if (dirs.length === 0) {
    return { pass: true, note: 'skills/ directory is empty — skipping' };
  }
  const missing = dirs.filter(d => !fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
  if (missing.length > 0) {
    return { pass: false, reason: `skills missing SKILL.md: ${missing.join(', ')}` };
  }
  return { pass: true };
}

function checkAgentsExist() {
  const agentsDir = path.join(claudeDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return { pass: false, reason: `agents/ directory not found at ${agentsDir}` };
  }
  const agents = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  if (agents.length === 0) {
    return { pass: false, reason: 'no .md files found in agents/' };
  }
  return { pass: true };
}

function checkOriginMetadata() {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    return { pass: true, note: 'no skills/ directory — skipping origin check' };
  }
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  if (skillDirs.length === 0) {
    return { pass: true, note: 'no skill directories — skipping origin check' };
  }

  // Sample up to 3 random skill directories
  const sample = skillDirs.sort(() => Math.random() - 0.5).slice(0, 3);
  const noOrigin = [];

  for (const skillName of sample) {
    const skillMd = path.join(skillsDir, skillName, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, 'utf8');
    // Check for YAML frontmatter with origin: field
    if (!content.includes('origin:')) {
      noOrigin.push(skillName);
    }
  }

  if (noOrigin.length > 0) {
    return { pass: false, reason: `skills missing origin: in frontmatter: ${noOrigin.join(', ')}` };
  }
  return { pass: true };
}

function checkNoDeletionsExist() {
  const meta = readMetadata();
  if (!meta || !Array.isArray(meta.deletions) || meta.deletions.length === 0) {
    return { pass: true, note: 'no deletions registered in metadata.json' };
  }

  const stillPresent = [];
  for (const entry of meta.deletions) {
    if (entry.includes('*')) {
      // Glob pattern: check if the parent directory exists
      const dir = path.join(claudeDir, entry.replace(/\/?\*.*$/, ''));
      if (fs.existsSync(dir)) {
        stillPresent.push(entry);
      }
    } else {
      // Literal path
      if (fs.existsSync(path.join(claudeDir, entry))) {
        stillPresent.push(entry);
      }
    }
  }

  if (stillPresent.length > 0) {
    return { pass: false, reason: `orphaned files still present (registered for deletion): ${stillPresent.join(', ')}` };
  }
  return { pass: true };
}

// ── Modular-only checks ───────────────────────────────────────────────────────

function checkManifestValid() {
  if (!manifestPath) {
    return { pass: false, reason: 'MANIFEST_PATH env var not set for modular smoke test' };
  }
  if (!fs.existsSync(manifestPath)) {
    return { pass: false, reason: `manifest.json not found at ${manifestPath}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { pass: false, reason: `manifest.json is not valid JSON: ${e.message}` };
  }
  if (!manifest.kit) {
    return { pass: false, reason: 'manifest.json missing "kit" field' };
  }
  if (!manifest.modules || typeof manifest.modules !== 'object') {
    return { pass: false, reason: 'manifest.json missing "modules" object' };
  }
  return { pass: true };
}

function checkManifestModulesComplete() {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { pass: false, reason: `manifest.json not found at ${manifestPath}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { pass: false, reason: 'manifest.json is not valid JSON' };
  }
  const modules = manifest.modules || {};
  const incomplete = [];
  for (const [modName, entry] of Object.entries(modules)) {
    if (!entry.version) incomplete.push(`${modName} (missing version)`);
    if (!entry.asset)   incomplete.push(`${modName} (missing asset)`);
  }
  if (incomplete.length > 0) {
    return { pass: false, reason: `incomplete module entries: ${incomplete.join(', ')}` };
  }
  if (Object.keys(modules).length === 0) {
    return { pass: false, reason: 'manifest.json has empty modules object' };
  }
  return { pass: true };
}

// ── Check registry ────────────────────────────────────────────────────────────

const checks = [
  { name: 'metadata-exists',       fn: checkMetadataExists,       critical: true  },
  { name: 'metadata-valid-json',   fn: checkMetadataValidJson,    critical: true  },
  { name: 'metadata-version-match', fn: checkVersionMatchesTag,   critical: true  },
  { name: 'metadata-builddate',    fn: checkBuildDateRecent,      critical: false },
  { name: 'settings-valid',        fn: checkSettingsValid,        critical: true  },
  { name: 'skills-have-skillmd',   fn: checkSkillsHaveSkillMd,    critical: true  },
  { name: 'agents-exist',          fn: checkAgentsExist,          critical: true  },
  { name: 'origin-metadata-present', fn: checkOriginMetadata,     critical: true  },
  { name: 'no-orphaned-deletions', fn: checkNoDeletionsExist,     critical: true  },
];

if (isModular) {
  checks.push(
    { name: 'manifest-valid',            fn: checkManifestValid,           critical: true },
    { name: 'manifest-modules-complete', fn: checkManifestModulesComplete, critical: true },
  );
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`[smoke-test] Post-Release Smoke Test`);
console.log(`[smoke-test] Release dir : ${releaseDir}`);
console.log(`[smoke-test] Release tag : ${releaseTag}`);
console.log(`[smoke-test] Modular     : ${isModular}`);
if (isModular) console.log(`[smoke-test] Manifest    : ${manifestPath}`);
console.log('='.repeat(60));

const results = [];
let criticalFailures = 0;

for (const check of checks) {
  let result;
  try {
    result = check.fn();
  } catch (err) {
    result = { pass: false, reason: `check threw an exception: ${err.message}` };
  }

  const label = result.pass ? '[PASS]' : '[FAIL]';
  const note  = result.note ? ` (${result.note})` : '';
  const reason = result.reason ? `: ${result.reason}` : '';

  console.log(`${label} ${check.name}${reason}${note}`);

  results.push({ name: check.name, ...result, critical: check.critical });

  if (!result.pass && check.critical) {
    criticalFailures++;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const passed  = results.filter(r => r.pass).length;
const failed  = results.filter(r => !r.pass).length;

console.log('\n' + '='.repeat(60));
console.log(`[smoke-test] Results: ${passed} passed, ${failed} failed (${criticalFailures} critical)`);

if (failed > 0) {
  console.log('\n[smoke-test] FAILED checks:');
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  - ${r.name}: ${r.reason}`);
  }
}

if (criticalFailures > 0) {
  console.log(`\n[smoke-test] RESULT: FAIL (${criticalFailures} critical failure(s))`);
  process.exit(1);
} else if (failed > 0) {
  console.log('\n[smoke-test] RESULT: WARN (non-critical failures only)');
  process.exit(0);
} else {
  console.log('\n[smoke-test] RESULT: PASS');
  process.exit(0);
}
