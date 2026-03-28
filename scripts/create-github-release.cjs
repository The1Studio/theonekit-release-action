/**
 * create-github-release.cjs
 * Create a GitHub Release with all module ZIPs + manifest.json as assets.
 * Also creates per-module tags: {module-name}@{version}
 *
 * Uses `gh` CLI for all GitHub operations (no npm deps).
 *
 * @param {object} opts
 * @param {string}   opts.releaseTag    Rolling tag e.g. "modules-20260327-1200"
 * @param {string}   opts.kitName       Display name e.g. "TheOneKit Unity"
 * @param {string}   opts.kitRepo       GitHub repo e.g. "The1Studio/theonekit-unity"
 * @param {string}   opts.kitDir        Absolute path to kit repo root (for git ops)
 * @param {string}   opts.manifestPath  Absolute path to manifest.json asset
 * @param {Array<{name: string, version: string, zipPath: string}>} opts.moduleAssets
 * @param {boolean}  [opts.dryRun=false]
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

/**
 * Run a shell command, returning stdout. Throws on non-zero exit.
 */
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts }).trim();
}

/**
 * Check if a git tag already exists locally or on remote.
 */
function tagExists(kitDir, tag) {
  try {
    run(`git rev-parse --verify "refs/tags/${tag}" 2>/dev/null`, { cwd: kitDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a lightweight git tag and push it.
 */
function createAndPushTag(kitDir, tag, dryRun) {
  if (tagExists(kitDir, tag)) {
    console.log(`  [tag] ${tag} already exists — skipping`);
    return;
  }
  if (dryRun) {
    console.log(`  [tag] dry-run: would create tag ${tag}`);
    return;
  }
  run(`git tag "${tag}"`, { cwd: kitDir });
  run(`git push origin "refs/tags/${tag}"`, { cwd: kitDir });
  console.log(`  [tag] Created and pushed: ${tag}`);
}

/**
 * Build the release notes body listing changed modules.
 */
function buildReleaseNotes(kitName, releaseTag, moduleAssets, manifestSummary) {
  const date = releaseTag.replace('modules-', '').replace(/-(\d{4})$/, ' $1').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const lines = [
    `## ${kitName} — ${date}`,
    '',
    '### Modules included',
    '',
  ];
  for (const { name, version } of moduleAssets) {
    const isRequired = manifestSummary?.modules?.[name]?.required ? ' _(required)_' : '';
    lines.push(`- **${name}** \`${version}\`${isRequired}`);
  }
  lines.push('', '### Assets', '', '- `manifest.json` — module index with versions and dependency ranges');
  for (const { name, version } of moduleAssets) {
    lines.push(`- \`${name}-${version}.zip\``);
  }
  return lines.join('\n');
}

/**
 * Create the GitHub Release with all assets attached.
 */
function createGithubRelease({ releaseTag, kitName, kitRepo, kitDir, manifestPath, moduleAssets, dryRun = false }) {
  console.log(`\n[release] Creating GitHub Release: ${releaseTag}`);

  // Validate all ZIP assets exist
  for (const asset of moduleAssets) {
    if (!asset.zipPath) continue; // dryRun may have null zipPath
    if (!fs.existsSync(asset.zipPath)) {
      throw new Error(`ZIP asset not found: ${asset.zipPath}`);
    }
  }

  // Read manifest for release notes
  let manifestSummary = null;
  if (fs.existsSync(manifestPath)) {
    try { manifestSummary = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* ok */ }
  }

  const notes = buildReleaseNotes(kitName, releaseTag, moduleAssets, manifestSummary);
  const title = `${kitName} Modules — ${releaseTag}`;

  if (dryRun) {
    console.log(`[release] dry-run: would create release "${title}"`);
    console.log(`[release] dry-run: assets: manifest.json + ${moduleAssets.length} ZIP(s)`);
    // Still create per-module tags in dry-run for visibility
    for (const { name, version } of moduleAssets) {
      console.log(`  [tag] dry-run: would create ${name}@${version}`);
    }
    return;
  }

  // Build gh release create command
  const assetArgs = [manifestPath, ...moduleAssets.filter(a => a.zipPath).map(a => a.zipPath)]
    .map(p => `"${p}"`)
    .join(' ');

  const notesFile = path.join(path.dirname(manifestPath), '_release-notes.tmp.md');
  fs.writeFileSync(notesFile, notes);

  try {
    run(
      `gh release create "${releaseTag}" ${assetArgs} --repo "${kitRepo}" --title "${title}" --notes-file "${notesFile}"`,
      { cwd: kitDir },
    );
    console.log(`[release] Release created: https://github.com/${kitRepo}/releases/tag/${releaseTag}`);
  } finally {
    fs.rmSync(notesFile, { force: true });
  }

  // Create per-module tags
  console.log(`\n[release] Creating per-module tags...`);
  for (const { name, version } of moduleAssets) {
    createAndPushTag(kitDir, `${name}@${version}`, dryRun);
  }
}

module.exports = { createGithubRelease };
