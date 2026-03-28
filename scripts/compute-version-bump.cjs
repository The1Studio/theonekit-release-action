/**
 * compute-version-bump.cjs
 * Determine semver bump type from a list of commits for one module.
 *
 * Rules:
 *   feat! or BREAKING CHANGE footer -> major
 *   feat                            -> minor
 *   fix, perf, refactor             -> patch
 *   anything else                   -> none
 *
 * @param {import('./parse-commits.cjs').Commit[]} commits
 * @returns {'major'|'minor'|'patch'|'none'}
 */

'use strict';

/**
 * Determine the bump type for a set of commits affecting one module.
 */
function computeBumpType(commits) {
  if (!commits || commits.length === 0) return 'none';

  let highest = 'none';

  for (const c of commits) {
    if (c.breaking) return 'major'; // Can't go higher — short-circuit

    const bump = typeToBump(c.type);
    highest = maxBump(highest, bump);
  }

  return highest;
}

/**
 * Map conventional commit type to bump level.
 */
function typeToBump(type) {
  switch (type) {
    case 'feat': return 'minor';
    case 'fix':
    case 'perf':
    case 'refactor':
    case 'revert': return 'patch';
    default: return 'none';
  }
}

/**
 * Return the higher of two bump levels.
 * Priority: major > minor > patch > none
 */
function maxBump(a, b) {
  const order = ['none', 'patch', 'minor', 'major'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

/**
 * Apply a bump to a semver string.
 *
 * @param {string} version  Current version (e.g. "1.2.3")
 * @param {'major'|'minor'|'patch'|'none'} bump
 * @returns {string}  New version string (unchanged if bump === 'none')
 */
function applyBump(version, bump) {
  if (bump === 'none') return version;

  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: "${version}"`);
  }

  let [major, minor, patch] = parts;
  switch (bump) {
    case 'major': major++; minor = 0; patch = 0; break;
    case 'minor': minor++; patch = 0; break;
    case 'patch': patch++; break;
  }
  return `${major}.${minor}.${patch}`;
}

module.exports = { computeBumpType, applyBump, maxBump };
