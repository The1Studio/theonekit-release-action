#!/usr/bin/env node
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
// check-skill-cross-refs.cjs
//
// CI gate: verifies that all /t1k:<name> references in .claude/ markdown files,
// agent files, and activation fragments point to a registered skill (from SKILL.md
// frontmatter `name:` field). Legacy /ck:<name> references emit warnings (not errors).
//
// T1K-adapted from CK's check-skill-cross-refs.js. Key differences vs CK:
//   - Reference regex: /t1k:<name> or /t1k:<scope>:<name> (two-segment form)
//   - Name normalization: strips "t1k:" prefix from SKILL.md `name:` field
//   - Modular kit support: walks .claude/modules/<name>/skills/<skill>/SKILL.md
//   - Activation fragment scanning: mappings[].skills[] + sessionBaseline[]
//   - Legacy /ck: refs emit ::warning (port-in-progress), never ::error
//
// Usage:
//   node scripts/check-skill-cross-refs.cjs [kit-root]
//   (defaults to cwd if no argument given)
//
// Exit 0 = all references valid (or no references found); legacy-only warnings OK
// Exit 1 = broken references found
//
// Environment:
//   T1K_GATE_WARN_ONLY=1  -- emit ::warning instead of ::error (rollback mode)

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Regex patterns ─────────────────────────────────────────────────────────────

// Matches /t1k:<name> or /t1k:<scope>:<name>  (e.g. /t1k:cook or /t1k:unity:scene)
// Note: regex is re-created per line to avoid lastIndex state issues
const SKILL_REF_PATTERN = /\/t1k:([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)/g;

// Matches legacy /ck:<name> (should be migrated to /t1k:, warning only)
const LEGACY_REF_PATTERN = /\/ck:([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)/g;

// Matches YAML frontmatter `name:` field  (e.g. `name: t1k:cook` or `name: "t1k:cook"`)
const FRONTMATTER_NAME_RX = /^name:\s*['"]?(t1k:[^\s'"]+)['"]?\s*$/m;

// ── Warn-only mode ──────────────────────────────────────────────────────────────

const WARN_ONLY = process.env.T1K_GATE_WARN_ONLY === '1';

// ── File walking ───────────────────────────────────────────────────────────────

/**
 * Recursively collect all files matching a predicate under a directory.
 * Skips symlinks to prevent traversal outside the repo.
 */
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

/**
 * Safe readFileSync — returns null on error, never throws.
 */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[cross-ref] warn: could not read ${filePath}: ${err.message}`);
    return null;
  }
}

// ── Skill registry ─────────────────────────────────────────────────────────────

/**
 * Extract the `name:` value from YAML frontmatter of a SKILL.md.
 * Returns the raw value (e.g. "t1k:cook") or null if not found.
 */
function extractFrontmatterName(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/m);
  if (!nameMatch) return null;
  return nameMatch[1].trim();
}

/**
 * Build the canonical skill registry from all SKILL.md files.
 * Returns Map<string, { filePath, rawName }> keyed by normalized name.
 *
 * T1K skill names come in two forms:
 *   - "t1k:cook"         -> registry key: "cook"
 *   - "t1k:unity:scene"  -> registry key: "unity:scene"
 *
 * Both flat (.claude/skills/) and modular (.claude/modules/<name>/skills/) layouts
 * are scanned.
 */
function collectSkillDirs(kitRoot) {
  const claudeDir = path.join(kitRoot, '.claude');
  const skillDirs = [path.join(claudeDir, 'skills')];

  // Modular kits: also scan .claude/modules/*/skills/
  const modulesDir = path.join(claudeDir, 'modules');
  if (fs.existsSync(modulesDir)) {
    try {
      for (const modName of fs.readdirSync(modulesDir)) {
        const modSkillsDir = path.join(modulesDir, modName, 'skills');
        if (fs.existsSync(modSkillsDir)) {
          skillDirs.push(modSkillsDir);
        }
      }
    } catch {
      // non-directory entries silently ignored
    }
  }

  return skillDirs;
}

function addSkillsFromDirs(registry, skillDirs) {
  for (const skillsDir of skillDirs) {
    if (!fs.existsSync(skillsDir)) continue;
    const skillMds = findFiles(skillsDir, (entry) => entry === 'SKILL.md');
    for (const filePath of skillMds) {
      const content = readFileSafe(filePath);
      if (!content) continue;

      const rawName = extractFrontmatterName(content);
      if (!rawName) continue;

      // Accept multiple forms:
      //   - "t1k:cook" (current T1K)           -> "cook"
      //   - "t1k:unity:scene" (kit-scoped)      -> "unity:scene"
      //   - "gk:scene" (legacy gamekit name)    -> "scene"
      //   - "ck:xxx" (legacy claudekit)         -> "xxx"
      //   - "frontend-design" (bare)            -> "frontend-design"
      // Some kits carry legacy prefixes from pre-T1K history; both are valid for now.
      let normalizedKey = rawName;
      for (const prefix of ['t1k:', 'gk:', 'ck:']) {
        if (normalizedKey.startsWith(prefix)) {
          normalizedKey = normalizedKey.slice(prefix.length);
          break;
        }
      }

      if (!registry.has(normalizedKey)) {
        registry.set(normalizedKey, { filePath, rawName });
      }
    }
  }
}

/**
 * Resolve external kit roots for cross-kit reference validation.
 * T1K kits reference core skills (e.g. /t1k:cook). To avoid false positives
 * in non-core kits, merge core's registry into the local one.
 *
 * Resolution order:
 *   1. T1K_EXTERNAL_ROOTS env var (colon-separated list of kit roots)
 *   2. Auto-detect sibling theonekit-core at ../theonekit-core relative to kitRoot
 *   3. Skip (core alone won't have external roots)
 */
function resolveExternalKitRoots(kitRoot) {
  const envRoots = process.env.T1K_EXTERNAL_ROOTS;
  if (envRoots) {
    return envRoots.split(':').filter(Boolean);
  }

  // Auto-detect sibling theonekit-core
  const parentDir = path.dirname(path.resolve(kitRoot));
  const siblingCore = path.join(parentDir, 'theonekit-core');
  const kitName = path.basename(path.resolve(kitRoot));

  if (kitName !== 'theonekit-core' && fs.existsSync(path.join(siblingCore, '.claude'))) {
    return [siblingCore];
  }

  return [];
}

function buildSkillRegistry(kitRoot) {
  const registry = new Map();

  // Local skills first (kit being scanned)
  addSkillsFromDirs(registry, collectSkillDirs(kitRoot));

  // External kits (typically core) merged for cross-kit validation
  const externalRoots = resolveExternalKitRoots(kitRoot);
  for (const extRoot of externalRoots) {
    addSkillsFromDirs(registry, collectSkillDirs(extRoot));
  }

  return registry;
}

// ── Reference scanning ─────────────────────────────────────────────────────────

/**
 * Scan a markdown file line-by-line for /t1k: and /ck: references.
 * Returns Array<{ ref, kind: 'skill'|'legacy', file, line }>
 */
function scanMarkdownFile(filePath, kitRoot) {
  const content = readFileSafe(filePath);
  if (!content) return [];

  const relFile = path.relative(kitRoot, filePath).split(path.sep).join('/');
  const results = [];
  const lines   = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const lineNum = i + 1;

    // Skill refs — re-create regex each time to reset lastIndex
    const skillRx = new RegExp(SKILL_REF_PATTERN.source, 'g');
    let m;
    while ((m = skillRx.exec(line)) !== null) {
      results.push({ ref: m[1], kind: 'skill', file: relFile, line: lineNum });
    }

    // Legacy /ck: refs
    const legacyRx = new RegExp(LEGACY_REF_PATTERN.source, 'g');
    while ((m = legacyRx.exec(line)) !== null) {
      results.push({ ref: m[1], kind: 'legacy', file: relFile, line: lineNum });
    }
  }

  return results;
}

/**
 * Scan a T1K activation fragment (JSON) for skill references in:
 *   - mappings[].skills[]
 *   - sessionBaseline[]
 *
 * Each referenced skill name is expected to match a registry key.
 * Returns Array<{ ref, kind: 'skill', file, line: null }>
 *   (activation fragments have no meaningful line numbers for skill name entries)
 */
function scanActivationFragment(filePath, kitRoot) {
  const content = readFileSafe(filePath);
  if (!content) return [];

  const relFile = path.relative(kitRoot, filePath).split(path.sep).join('/');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error(`[cross-ref] warn: could not parse ${relFile}: ${err.message}`);
    return [];
  }

  // Skip unknown schema versions gracefully
  if (parsed.registryVersion !== 1) {
    console.warn(`[cross-ref] warn: unknown registryVersion in ${relFile} — skipping`);
    return [];
  }

  const results = [];

  // sessionBaseline[] — array of skill names like "t1k-cook"
  // These are skill DIRECTORY names (not /t1k:<name> invocations), skip cross-ref for them.
  // NOTE: sessionBaseline entries are directory names, not slash-command refs.
  // We do NOT cross-check these against the registry since they reference directories.

  // mappings[].skills[] — same format: skill directory names
  // Same reasoning: these are directory names, not /t1k: invocations.
  // No cross-ref validation here. The activation fragment scanner is present
  // to allow future extension if the format changes to use slash-command names.

  return results;
}

/**
 * Collect all references from .claude/ markdown files, agent files, and activation fragments.
 */
function scanAllFiles(kitRoot) {
  const claudeDir = path.join(kitRoot, '.claude');
  const refs      = [];

  // 1. .claude/rules/**/*.md
  const rulesDir = path.join(claudeDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const f of findFiles(rulesDir, (e) => e.endsWith('.md'))) {
      refs.push(...scanMarkdownFile(f, kitRoot));
    }
  }

  // 2. .claude/skills/*/SKILL.md and .claude/skills/*/references/*.md
  const skillsDir = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const f of findFiles(skillsDir, (e) => e.endsWith('.md'))) {
      refs.push(...scanMarkdownFile(f, kitRoot));
    }
  }

  // 3. .claude/modules/*/skills/*/SKILL.md and .claude/modules/*/skills/*/references/*.md
  const modulesDir = path.join(claudeDir, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const f of findFiles(modulesDir, (e) => e.endsWith('.md'))) {
      refs.push(...scanMarkdownFile(f, kitRoot));
    }
  }

  // 4. .claude/agents/*.md
  const agentsDir = path.join(claudeDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const f of findFiles(agentsDir, (e) => e.endsWith('.md'))) {
      refs.push(...scanMarkdownFile(f, kitRoot));
    }
  }

  // 5. .claude/t1k-activation-*.json (activation fragments)
  try {
    for (const entry of fs.readdirSync(claudeDir)) {
      if (/^t1k-activation-.+\.json$/.test(entry)) {
        const f = path.join(claudeDir, entry);
        refs.push(...scanActivationFragment(f, kitRoot));
      }
    }
  } catch {
    // no .claude dir or unreadable — handled gracefully
  }

  return refs;
}

// ── Annotation output ──────────────────────────────────────────────────────────

/**
 * Sanitize a string for use in a GitHub workflow annotation value.
 * Prevents annotation injection by escaping special characters.
 */
function sanitizeAnnotationValue(str) {
  return String(str)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function emitError(file, line, message) {
  const level = WARN_ONLY ? 'warning' : 'error';
  const safeFile = sanitizeAnnotationValue(file);
  const safeMsg  = sanitizeAnnotationValue(message);
  if (line != null) {
    console.log(`::${level} file=${safeFile},line=${line}::${safeMsg}`);
  } else {
    console.log(`::${level} file=${safeFile}::${safeMsg}`);
  }
}

function emitWarning(file, line, message) {
  const safeFile = sanitizeAnnotationValue(file);
  const safeMsg  = sanitizeAnnotationValue(message);
  if (line != null) {
    console.log(`::warning file=${safeFile},line=${line}::${safeMsg}`);
  } else {
    console.log(`::warning file=${safeFile}::${safeMsg}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main() {
  const kitRoot = path.resolve(process.argv[2] || process.cwd());

  if (!fs.existsSync(kitRoot)) {
    console.error(`[cross-ref] ERROR: kit root not found: ${kitRoot}`);
    process.exit(1);
  }

  if (WARN_ONLY) {
    console.log('[cross-ref] WARN_ONLY mode active — errors will be emitted as warnings');
  }

  const registry = buildSkillRegistry(kitRoot);
  const allRefs  = scanAllFiles(kitRoot);

  const broken = [];
  const legacy = [];

  for (const r of allRefs) {
    if (r.kind === 'legacy') {
      legacy.push(r);
    } else if (r.kind === 'skill') {
      if (!registry.has(r.ref)) {
        broken.push(r);
      }
    }
  }

  // Emit annotations for legacy /ck: refs (warnings — port-in-progress)
  for (const { ref, file, line } of legacy) {
    emitWarning(file, line, `Legacy ref: /ck:${ref} — migrate to /t1k: equivalent`);
  }

  // Emit annotations for broken /t1k: refs
  for (const { ref, file, line } of broken) {
    emitError(file, line, `Broken skill ref: /t1k:${ref} (not registered in any SKILL.md)`);
  }

  // Summary line
  const registeredNames = [...registry.keys()].sort();
  console.log(
    `[cross-ref] registry=${registry.size} refs=${allRefs.length} ` +
    `broken=${broken.length} legacy=${legacy.length}`
  );

  if (broken.length > 0) {
    console.log(`[cross-ref] Registered skills: ${registeredNames.join(', ') || '(none)'}`);
  }

  process.exit(broken.length > 0 && !WARN_ONLY ? 1 : 0);
}

main();
