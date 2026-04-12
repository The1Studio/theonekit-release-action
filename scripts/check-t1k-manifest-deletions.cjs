#!/usr/bin/env node
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
/**
 * check-t1k-manifest-deletions.cjs
 *
 * CI gate: validates that files listed in deletions[] do NOT exist in the
 * working tree. If a deletion entry still exists, the file was not cleaned up
 * and the gate fails.
 *
 * Handles both T1K kit schemas:
 *
 *   FLAT KITS (core, web, cli, release-action, nakama, telemetry-worker):
 *     .claude/metadata.json → deletions[] array
 *
 *   MODULAR KITS (unity, rn, cocos, designer):
 *     .claude/modules/<name>/.t1k-manifest.json → deletions[] array
 *     (may also have .claude/metadata.json with deletions — both are checked)
 *
 * Glob support for deletion entries (relative to .claude/ dir):
 *   - Exact path:    "skills/t1k-foo/SKILL.md"
 *   - Single-star:   "skills/old-skill/*"  (non-recursive, one level)
 *   - Double-star:   "skills/old-module/**" (recursive, all descendants)
 *
 * Path resolution: entries are resolved relative to <kitRoot>/.claude/.
 * Entries that already start with ".claude/" have that prefix stripped.
 *
 * Usage:
 *   node scripts/check-t1k-manifest-deletions.cjs [kit-root]
 *   (defaults to cwd if no argument given)
 *
 * Exit 0 = all deletion entries absent from working tree (or no entries found)
 * Exit 1 = one or more deletion entries still present in working tree
 *
 * Environment:
 *   T1K_GATE_WARN_ONLY=1  — emit ::warning instead of ::error (rollback mode)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Warn-only mode ──────────────────────────────────────────────────────────────

const WARN_ONLY = process.env.T1K_GATE_WARN_ONLY === '1';

// ── Safe JSON reader ───────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns null if file missing or invalid JSON.
 * Does NOT throw.
 */
function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[manifest-deletions] warn: could not parse ${filePath}: ${err.message}`);
    return null;
  }
}

// ── Deletion collection ────────────────────────────────────────────────────────

/**
 * Normalize a deletion entry: strip leading ".claude/" if present.
 * The returned value is relative to <kitRoot>/.claude/.
 */
function normalizeEntry(entry) {
  const e = String(entry).trim();
  if (e.startsWith('.claude/')) return e.slice(8);
  if (e.startsWith('claude/'))  return e.slice(7);
  return e;
}

/**
 * Collect all deletion entries from both flat and modular kit schemas.
 * Returns Array<{ source: string, entry: string }>
 *   - source: human-readable origin (e.g. ".claude/metadata.json" or ".claude/modules/rn-base/.t1k-manifest.json")
 *   - entry:  normalized path relative to .claude/ dir
 */
function collectDeletions(kitRoot) {
  const claudeDir = path.join(kitRoot, '.claude');
  const results   = [];

  // 1. Flat kit: .claude/metadata.json deletions[]
  const metaPath = path.join(claudeDir, 'metadata.json');
  const meta     = readJsonSafe(metaPath);
  if (meta && Array.isArray(meta.deletions)) {
    for (const entry of meta.deletions) {
      results.push({ source: '.claude/metadata.json', entry: normalizeEntry(entry) });
    }
  }

  // 2. Modular kit: .claude/modules/*/.t1k-manifest.json deletions[]
  const modulesDir = path.join(claudeDir, 'modules');
  if (fs.existsSync(modulesDir)) {
    let modNames;
    try {
      modNames = fs.readdirSync(modulesDir);
    } catch {
      modNames = [];
    }
    for (const modName of modNames) {
      const manifestPath = path.join(modulesDir, modName, '.t1k-manifest.json');
      const manifest     = readJsonSafe(manifestPath);
      if (manifest && Array.isArray(manifest.deletions)) {
        const source = `.claude/modules/${modName}/.t1k-manifest.json`;
        for (const entry of manifest.deletions) {
          results.push({ source, entry: normalizeEntry(entry) });
        }
      }
    }
  }

  return results;
}

// ── Glob expansion ─────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and collect all file paths (not dirs).
 * Returns Array<string> of absolute paths.
 */
function walkDir(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Match a filename against a simple single-star pattern (non-recursive).
 * Pattern `*` matches any sequence of non-separator characters.
 * Returns true if filename matches the pattern.
 */
function matchSingleStar(pattern, filename) {
  // Escape regex specials except *
  const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$';
  return new RegExp(regexStr).test(filename);
}

/**
 * Expand a deletion entry (relative to claudeDir) into a list of absolute paths
 * that CURRENTLY EXIST in the working tree.
 *
 * Three patterns supported:
 *   exact:   "skills/t1k-foo/SKILL.md"       → single path
 *   single:  "skills/old-skill/*"            → direct children of dir
 *   double:  "skills/old-module/**"           → all descendants recursively
 */
function expandEntry(claudeDir, entry) {
  const existing = [];

  if (entry.endsWith('/**')) {
    // Double-star glob: all files under the directory
    const dirPath = path.join(claudeDir, entry.slice(0, -3)); // strip "/**"
    if (fs.existsSync(dirPath)) {
      existing.push(...walkDir(dirPath));
    }
  } else if (entry.includes('/*') && !entry.includes('/**')) {
    // Single-star glob: direct children matching pattern
    const lastSep  = entry.lastIndexOf('/');
    const dirPart  = entry.slice(0, lastSep);
    const pattern  = entry.slice(lastSep + 1);
    const dirPath  = path.join(claudeDir, dirPart);
    if (fs.existsSync(dirPath)) {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        dirEntries = [];
      }
      for (const de of dirEntries) {
        if (de.isFile() && matchSingleStar(pattern, de.name)) {
          existing.push(path.join(dirPath, de.name));
        }
      }
    }
  } else {
    // Exact path
    const absPath = path.join(claudeDir, entry);
    if (fs.existsSync(absPath)) {
      existing.push(absPath);
    }
  }

  return existing;
}

// ── Annotation output ──────────────────────────────────────────────────────────

/**
 * Sanitize a string for use in a GitHub workflow annotation value.
 */
function sanitizeAnnotationValue(str) {
  return String(str)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function emitAnnotation(source, entry, existingFile, kitRoot) {
  const level    = WARN_ONLY ? 'warning' : 'error';
  const relExist = path.relative(kitRoot, existingFile).split(path.sep).join('/');
  const safeFile = sanitizeAnnotationValue(source);
  const safeMsg  = sanitizeAnnotationValue(
    `Deletion entry "${entry}" still exists at ${relExist} — file must be removed before release`
  );
  console.log(`::${level} file=${safeFile}::${safeMsg}`);
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * For each deletion entry, check that no matching files exist in the working tree.
 * Returns Array<{ source, entry, existingFile }> — the violations.
 */
function validate(kitRoot, deletions) {
  const claudeDir  = path.join(kitRoot, '.claude');
  const violations = [];

  for (const { source, entry } of deletions) {
    const existingFiles = expandEntry(claudeDir, entry);
    for (const existingFile of existingFiles) {
      violations.push({ source, entry, existingFile });
    }
  }

  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main() {
  const kitRoot = path.resolve(process.argv[2] || process.cwd());

  if (!fs.existsSync(kitRoot)) {
    console.error(`[manifest-deletions] ERROR: kit root not found: ${kitRoot}`);
    process.exit(1);
  }

  if (WARN_ONLY) {
    console.log('[manifest-deletions] WARN_ONLY mode active — errors will be emitted as warnings');
  }

  const deletions  = collectDeletions(kitRoot);
  const violations = validate(kitRoot, deletions);

  for (const v of violations) {
    emitAnnotation(v.source, v.entry, v.existingFile, kitRoot);
  }

  console.log(
    `[manifest-deletions] checked=${deletions.length} violations=${violations.length}`
  );

  process.exit(violations.length > 0 && !WARN_ONLY ? 1 : 0);
}

main();
