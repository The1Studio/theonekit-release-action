/**
 * parse-commits.cjs
 * Parse conventional commits since last release tag, group by scope -> module.
 *
 * @param {string} kitDir  Path to kit repo root.
 * @param {string[]} moduleNames  Known module names (from module.json files).
 * @param {string} kitName  Kit repo name (e.g. "theonekit-unity") for kit-scope detection.
 * @returns {CommitAnalysis}
 *
 * @typedef {{ type: string, scope: string|null, breaking: boolean, hash: string, subject: string }} Commit
 * @typedef {{ affectedModules: Map<string,Commit[]>, breakingAll: boolean, hasChanges: boolean }} CommitAnalysis
 */

'use strict';

const { execSync } = require('child_process');

/**
 * Find the last release tag matching the pattern "modules-*".
 * Returns null if no release tag exists yet (first release).
 */
function findLastReleaseTag(kitDir) {
  try {
    const tag = execSync('git describe --tags --match "modules-*" --abbrev=0 2>/dev/null', {
      cwd: kitDir,
      encoding: 'utf8',
    }).trim();
    return tag || null;
  } catch {
    return null; // No matching tag — this is the first release
  }
}

/**
 * Get all commits since a tag (or all commits if tag is null).
 * Returns raw "HASH TYPE(SCOPE): SUBJECT" lines.
 */
function getCommitsSinceTag(kitDir, sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  try {
    const raw = execSync(`git log --format="%H %s" ${range} 2>/dev/null`, {
      cwd: kitDir,
      encoding: 'utf8',
    }).trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Parse a single commit log line into a structured Commit object.
 * Conventional commit format: type(scope): subject
 * Also detects breaking changes via `!` after type/scope.
 */
function parseCommitLine(line) {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return null;

  const hash = line.substring(0, spaceIdx);
  const subject = line.substring(spaceIdx + 1).trim();

  // Match: type(scope)!: subject  or  type!: subject  or  type(scope): subject  or  type: subject
  const match = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/);
  if (!match) return null;

  const [, type, scope, bangMark, rest] = match;
  const breaking = bangMark === '!' || rest.includes('BREAKING CHANGE');

  return { hash, type, scope: scope || null, breaking, subject };
}

/**
 * Determine which modules are affected by a commit.
 *
 * Rules (in priority order):
 * 1. scope matches exact module name -> that module only
 * 2. scope matches kit name -> ALL modules (kit-wide change)
 * 3. breaking change with no scope -> ALL modules
 * 4. no scope, non-breaking -> no module (e.g. chore, docs)
 */
function getAffectedModules(commit, moduleNames, kitName) {
  const scope = commit.scope ? commit.scope.toLowerCase() : null;

  // Exact module match (single scope)
  if (scope && moduleNames.includes(scope)) {
    return [scope];
  }

  // Multi-scope: "dots-core,dots-combat" → match each individually
  if (scope && scope.includes(',')) {
    const matched = scope.split(',').map(s => s.trim()).filter(s => moduleNames.includes(s));
    if (matched.length > 0) return matched;
  }

  // Kit-scope or breaking with no scope -> all modules
  if (scope === kitName || (commit.breaking && !scope)) {
    return moduleNames;
  }

  // Unscoped feat/fix/refactor/perf commits are kit-wide changes — affect ALL modules
  // This ensures `fix: add effort field` bumps versions instead of being silently dropped
  if (!scope && ['feat', 'fix', 'refactor', 'perf'].includes(commit.type)) {
    return moduleNames;
  }

  return [];
}

/**
 * Analyze all commits since last release.
 *
 * @param {string} kitDir
 * @param {string[]} moduleNames
 * @param {string} kitName
 * @returns {CommitAnalysis}
 */
function analyzeCommits(kitDir, moduleNames, kitName) {
  const lastTag = findLastReleaseTag(kitDir);
  if (lastTag) {
    console.log(`[commits] Last release tag: ${lastTag}`);
  } else {
    console.log('[commits] No previous release tag found — treating all commits as new');
  }

  const lines = getCommitsSinceTag(kitDir, lastTag);
  console.log(`[commits] ${lines.length} commit(s) to analyze`);

  const affectedModules = new Map(); // moduleName -> Commit[]
  let breakingAll = false;

  for (const line of lines) {
    const commit = parseCommitLine(line);
    if (!commit) continue;

    // Skip non-release commit types
    if (['chore', 'docs', 'style', 'test', 'ci'].includes(commit.type) && !commit.breaking) {
      continue;
    }

    const targets = getAffectedModules(commit, moduleNames, kitName);

    // Breaking with kit scope sets global flag
    if (commit.breaking && (targets.length === moduleNames.length)) {
      breakingAll = true;
    }

    for (const mod of targets) {
      if (!affectedModules.has(mod)) affectedModules.set(mod, []);
      affectedModules.get(mod).push(commit);
    }
  }

  console.log(`[commits] Affected modules: ${[...affectedModules.keys()].join(', ') || '(none)'}`);
  if (breakingAll) console.log('[commits] Breaking change detected — all modules get major bump');

  return {
    affectedModules,
    breakingAll,
    hasChanges: affectedModules.size > 0,
    lastTag,
  };
}

module.exports = { analyzeCommits, findLastReleaseTag };
