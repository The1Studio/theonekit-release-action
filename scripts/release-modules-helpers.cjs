/**
 * release-modules-helpers.cjs
 * Helper utilities for release-modules.cjs:
 *   - resolveKitRepo  — detect GitHub owner/repo from env or git remote
 *   - readModulesRegistry — parse t1k-modules.json
 *   - listModuleNames — list module dirs from .claude/modules/
 *   - buildReleaseTag — generate rolling tag "modules-YYYYMMDD-HHMM"
 *   - commitVersionBumps — git commit + push updated module.json files
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Resolve the GitHub owner/repo slug.
 * Checks GITHUB_REPO env first, then falls back to `git remote get-url origin`.
 *
 * @param {string} kitDir
 * @returns {string}  e.g. "The1Studio/theonekit-unity"
 */
function resolveKitRepo(kitDir) {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  try {
    const remote = run('git remote get-url origin', kitDir);
    const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch { /* fall through */ }
  console.error('[release] Cannot determine GITHUB_REPO. Set env or ensure git remote is GitHub.');
  process.exit(1);
}

/**
 * Read and return the parsed t1k-modules.json registry.
 *
 * @param {string} claudeDir  Absolute path to .claude/ directory.
 * @returns {object}
 */
function readModulesRegistry(claudeDir) {
  const p = path.join(claudeDir, 't1k-modules.json');
  if (!fs.existsSync(p)) throw new Error(`t1k-modules.json not found at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * List module names by reading subdirectory names from .claude/modules/.
 * Returns sorted array of names.
 *
 * @param {string} modulesDir  Absolute path to .claude/modules/
 * @returns {string[]}
 */
function listModuleNames(modulesDir) {
  if (!fs.existsSync(modulesDir)) return [];
  return fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

/**
 * Build a rolling release tag in the format: modules-YYYYMMDD-HHMM (UTC).
 *
 * @returns {string}  e.g. "modules-20260327-1200"
 */
function buildReleaseTag() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `modules-${date}-${time}`;
}

/**
 * Stage and commit updated module.json files, then push to origin HEAD.
 * No-op if bumpedModules is empty.
 *
 * @param {string}   kitDir
 * @param {string[]} bumpedModules  Names of modules whose module.json was updated.
 * @param {boolean}  dryRun
 */
function commitVersionBumps(kitDir, bumpedModules, dryRun) {
  if (bumpedModules.length === 0) return;
  const files = bumpedModules.map(m => `.claude/modules/${m}/module.json`).join(' ');
  const msg   = `chore(release): bump module versions\n\n${bumpedModules.join(', ')}`;
  if (dryRun) {
    console.log(`[release] dry-run: would commit version bumps for: ${bumpedModules.join(', ')}`);
    return;
  }
  run(`git add ${files}`, kitDir);
  run(`git commit -m "${msg.replace(/"/g, '\\"')}"`, kitDir);
  run('git push origin HEAD', kitDir);
  console.log(`[release] Committed and pushed version bumps: ${bumpedModules.join(', ')}`);
}

/**
 * Commit all .claude/ transformations (metadata injection, agent prefixes, version bumps,
 * synced registries) in one unified commit, then push with retry.
 *
 * Retries up to 3 times on push failure by rebasing and retrying.
 * No-op (no error) if there are no staged changes.
 *
 * @param {string}  kitDir
 * @param {boolean} dryRun
 */
function commitTransformations(kitDir, dryRun) {
  if (dryRun) {
    console.log('[release] dry-run: would commit metadata, prefixes, and versions');
    return;
  }

  // Stage all .claude/ changes and module.json files
  run('git add .claude/', kitDir);
  // Also stage any module.json files that were version-bumped
  try { run('git add ".claude/modules/**/module.json"', kitDir); } catch { /* glob may find nothing */ }

  // Check if there is anything to commit
  let hasStagedChanges = false;
  try {
    run('git diff --cached --quiet', kitDir);
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    console.log('[release] No changes to commit — working tree already up to date');
    return;
  }

  // Configure git identity (ARC runners may not have global config)
  try { run('git config user.name "github-actions[bot]"', kitDir); } catch { /* already set */ }
  try { run('git config user.email "github-actions[bot]@users.noreply.github.com"', kitDir); } catch { /* already set */ }

  const msg = 'chore(ci): update metadata, prefixes, and versions [skip ci]';
  run(`git commit -m "${msg}"`, kitDir);
  console.log('[release] Committed transformations');

  // Push with retry (up to 3 attempts, rebase on conflict)
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      run('git push origin HEAD', kitDir);
      console.log('[release] Pushed transformation commit to origin');
      return;
    } catch (pushErr) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`[release] Push failed after ${MAX_RETRIES} attempts: ${pushErr.message}`);
      }
      console.warn(`[release] Push attempt ${attempt} failed — rebasing and retrying...`);
      run('git pull --rebase origin HEAD', kitDir);
    }
  }
}

module.exports = {
  resolveKitRepo,
  readModulesRegistry,
  listModuleNames,
  buildReleaseTag,
  commitVersionBumps,
  commitTransformations,
};
