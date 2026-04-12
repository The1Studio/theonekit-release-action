#!/usr/bin/env node
'use strict';
// auto-compute-deletions.cjs — Release pipeline step
// Diffs .claude/ files between the last release tag and HEAD to automatically
// compute which files were deleted. Updates metadata.json (flat kits) and
// .t1k-manifest.json (modular kits) with the computed deletions[] arrays.
//
// NEVER removes entries that still exist at HEAD — stale deletion entries are
// cleaned up automatically.
//
// Cross-platform: no /dev/stdin, no /tmp hardcodes, no shell: true.
//
// Usage: node scripts/auto-compute-deletions.cjs <kit-root-path>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const kitRoot = process.argv[2] || '.';
const claudeDir = path.join(kitRoot, '.claude');

if (!fs.existsSync(claudeDir)) {
    console.log('[auto-compute-deletions] No .claude/ directory — skipping');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Git helpers (cross-platform: execFileSync, no shell: true)
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory.
 * Returns trimmed stdout string on success, or null on error.
 */
function gitRun(args, cwd) {
    try {
        return execFileSync('git', args, {
            cwd,
            stdio: ['pipe', 'pipe', 'ignore'],
            encoding: 'utf8',
        }).trim();
    } catch (_) {
        return null;
    }
}

/**
 * Find the most recent release tag.
 * Tries semantic versioning tags (v*) first, then module release tags (modules-*).
 * Returns the tag string, or null if none found.
 */
function findLastReleaseTag(kitRoot) {
    // Try semantic tags: v1.2.3, v1.2.3-rc.1, etc.
    const semverOut = gitRun(
        ['tag', '--sort=-v:refname', '--list', 'v*'],
        kitRoot
    );
    if (semverOut) {
        const tags = semverOut.split('\n').map(t => t.trim()).filter(Boolean);
        if (tags.length > 0) return tags[0];
    }

    // Try modular release tags: modules-20250401-abc1234, etc.
    const modulesOut = gitRun(
        ['tag', '--sort=-v:refname', '--list', 'modules-*'],
        kitRoot
    );
    if (modulesOut) {
        const tags = modulesOut.split('\n').map(t => t.trim()).filter(Boolean);
        if (tags.length > 0) return tags[0];
    }

    return null;
}

/**
 * List all .claude/ files tracked at a given git ref.
 * Returns a Set of paths relative to the repo root (forward slashes).
 */
function listFilesAtRef(ref, kitRoot) {
    // git ls-tree -r --name-only <ref> -- .claude/
    // Paths are relative to the repo root
    const out = gitRun(
        ['ls-tree', '-r', '--name-only', ref, '--', '.claude/'],
        kitRoot
    );
    if (!out) return new Set();
    return new Set(
        out.split('\n').map(p => p.trim()).filter(Boolean)
    );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Recursively list all files under a directory.
 * Returns an array of absolute paths.
 */
function listFilesRecursive(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...listFilesRecursive(fullPath));
        } else if (entry.isFile()) {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Convert an absolute path inside kitRoot to a repo-root-relative path
 * using forward slashes (as git reports).
 */
function toRepoRelative(absPath, kitRoot) {
    // Normalise both to forward slashes for comparison
    const rel = path.relative(kitRoot, absPath).split(path.sep).join('/');
    return rel;
}

// ---------------------------------------------------------------------------
// Deletion path optimisation
// ---------------------------------------------------------------------------

/**
 * Given a list of deleted paths (relative to .claude/), collapse paths that
 * share a common directory prefix into a single glob entry.
 *
 * Strategy: if ALL files under a directory are deleted (i.e. none remain at HEAD),
 * replace the individual entries with `dir/**`.
 *
 * @param {string[]} deletedRelative  Paths relative to .claude/ (forward slashes)
 * @param {Set<string>} headRelativeSet  Set of repo-relative paths at HEAD
 * @param {string} claudeRelPrefix  "  .claude/" prefix for repo-relative head paths
 */
function optimiseDeletions(deletedRelative, headRelativeSet, claudeRelPrefix) {
    // Group by first directory segment
    const dirGroups = {};
    for (const p of deletedRelative) {
        const parts = p.split('/');
        if (parts.length < 2) {
            // Top-level file — no directory group
            dirGroups[''] = dirGroups[''] || [];
            dirGroups[''].push(p);
        } else {
            const dir = parts[0];
            dirGroups[dir] = dirGroups[dir] || [];
            dirGroups[dir].push(p);
        }
    }

    const optimised = [];
    for (const [dir, files] of Object.entries(dirGroups)) {
        if (!dir) {
            // Top-level files — keep as-is
            optimised.push(...files);
            continue;
        }
        // Check if any file under this directory still exists at HEAD
        const dirPrefix = `${claudeRelPrefix}${dir}/`;
        const anyRemains = [...headRelativeSet].some(p => p.startsWith(dirPrefix));
        if (!anyRemains) {
            // Entire directory was removed — use glob
            optimised.push(`${dir}/**`);
        } else {
            // Some files remain — keep individual entries
            optimised.push(...files);
        }
    }

    return [...new Set(optimised)]; // dedupe
}

// ---------------------------------------------------------------------------
// Module manifest helpers
// ---------------------------------------------------------------------------

/**
 * Load a .t1k-manifest.json file. Returns null if missing or invalid.
 */
function loadManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

/**
 * Write a JSON object back to a file, pretty-printed.
 */
function writeJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Merge two deletions arrays: union, dedupe.
 */
function mergeDeletions(existing, computed) {
    return [...new Set([...(existing || []), ...(computed || [])])];
}

/**
 * Remove entries from a deletions[] array that still exist at HEAD.
 * @param {string[]} deletions  Entries relative to .claude/
 * @param {Set<string>} headClaudeRelative  Set of .claude/-relative paths at HEAD
 */
function removeStaleEntries(deletions, headClaudeRelative) {
    return deletions.filter(entry => {
        if (entry.endsWith('/**')) {
            // Glob: keep if the directory doesn't exist at HEAD (no files under it)
            const dir = entry.slice(0, -3); // strip /**
            return ![...headClaudeRelative].some(p => p.startsWith(`${dir}/`));
        }
        // Exact path: keep if the file doesn't exist at HEAD
        return !headClaudeRelative.has(entry);
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const lastTag = findLastReleaseTag(kitRoot);
if (!lastTag) {
    console.log('[auto-compute-deletions] No release tag found — skipping (nothing to diff against)');
    process.exit(0);
}

console.log(`[auto-compute-deletions] Diffing against tag: ${lastTag}`);

// Files tracked in .claude/ at last tag (repo-relative, forward slashes)
const tagFiles = listFilesAtRef(lastTag, kitRoot);

// Files in .claude/ at HEAD (absolute paths → repo-relative)
const headAbsPaths = listFilesRecursive(claudeDir);
const headRepoRelative = new Set(
    headAbsPaths.map(p => toRepoRelative(p, kitRoot))
);

// The .claude/ prefix as it appears in repo-relative paths
// (handle subdirectory repos: git ls-tree paths include subdirectory prefix)
// Determine prefix by looking at what tagFiles contains
let claudeRelPrefix = '.claude/';
for (const p of tagFiles) {
    // Find the suffix after the last occurrence of ".claude/"
    const idx = p.indexOf('.claude/');
    if (idx !== -1) {
        claudeRelPrefix = p.slice(0, idx + '.claude/'.length);
        break;
    }
}

// Deleted = in tag but NOT in HEAD
const deletedRepoRelative = [...tagFiles].filter(p => !headRepoRelative.has(p));

if (deletedRepoRelative.length === 0) {
    console.log('[auto-compute-deletions] No deleted .claude/ files detected — nothing to add');
    process.exit(0);
}

console.log(`[auto-compute-deletions] ${deletedRepoRelative.length} deleted file(s) detected`);

// Convert to .claude/-relative paths
const deletedClaudeRelative = deletedRepoRelative.map(p => {
    const idx = p.indexOf('.claude/');
    return idx !== -1 ? p.slice(idx + '.claude/'.length) : p;
});

// Build a Set of HEAD .claude/-relative paths (for stale-entry removal)
const headClaudeRelative = new Set(
    [...headRepoRelative]
        .filter(p => p.startsWith(claudeRelPrefix))
        .map(p => p.slice(claudeRelPrefix.length))
);

// Optimise deletions (collapse entire-directory removals into globs)
const optimised = optimiseDeletions(deletedClaudeRelative, headRepoRelative, claudeRelPrefix);

// ---------------------------------------------------------------------------
// Flat kit: update .claude/metadata.json
// ---------------------------------------------------------------------------
const metadataPath = path.join(claudeDir, 'metadata.json');
let metadata = null;
if (fs.existsSync(metadataPath)) {
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (e) {
        console.warn(`[auto-compute-deletions] Could not parse metadata.json: ${e.message}`);
    }
}

if (metadata) {
    // Remove stale entries first, then merge computed deletions
    const existing = Array.isArray(metadata.deletions) ? metadata.deletions : [];
    const cleaned = removeStaleEntries(existing, headClaudeRelative);
    const merged = mergeDeletions(cleaned, optimised);

    // Only update if changed
    if (JSON.stringify(merged.sort()) !== JSON.stringify((metadata.deletions || []).slice().sort())) {
        metadata.deletions = merged;

        // Mark that this field is auto-generated
        metadata._generatedFields = metadata._generatedFields || [];
        if (!metadata._generatedFields.includes('deletions')) {
            metadata._generatedFields.push('deletions');
        }

        writeJson(metadataPath, metadata);
        console.log(`[auto-compute-deletions] Updated metadata.json with ${merged.length} deletion(s)`);
    } else {
        console.log('[auto-compute-deletions] metadata.json deletions[] is already up to date');
    }
} else {
    console.log('[auto-compute-deletions] No metadata.json found — skipping flat-kit update');
}

// ---------------------------------------------------------------------------
// Modular kit: update per-module .t1k-manifest.json files
// ---------------------------------------------------------------------------
const modulesDir = path.join(claudeDir, 'modules');
if (fs.existsSync(modulesDir)) {
    const moduleNames = fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

    for (const moduleName of moduleNames) {
        const manifestPath = path.join(modulesDir, moduleName, '.t1k-manifest.json');
        const manifest = loadManifest(manifestPath);
        if (!manifest) continue;

        // The module owns files listed in manifest.files[] (relative to .claude/)
        const moduleFilePrefix = `modules/${moduleName}/`;
        const moduleDeleted = optimised.filter(p => {
            // Match exact paths and glob patterns under this module's directory
            if (p.endsWith('/**')) {
                return p.startsWith(moduleFilePrefix);
            }
            return p.startsWith(moduleFilePrefix);
        });

        if (moduleDeleted.length === 0) continue;

        const existing = Array.isArray(manifest.deletions) ? manifest.deletions : [];
        const cleaned = removeStaleEntries(existing, headClaudeRelative);
        const merged = mergeDeletions(cleaned, moduleDeleted);

        if (JSON.stringify(merged.sort()) !== JSON.stringify((manifest.deletions || []).slice().sort())) {
            manifest.deletions = merged;
            writeJson(manifestPath, manifest);
            console.log(`[auto-compute-deletions] Updated modules/${moduleName}/.t1k-manifest.json with ${merged.length} deletion(s)`);
        }
    }
}

console.log('[auto-compute-deletions] Done');
process.exit(0);
