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
 * @param {Map<string,Array<{type:string, scope:string|null, breaking:boolean, hash:string, subject:string}>>} [opts.affectedModules]  Per-module commits for changelog
 * @param {string[]} [opts.extraAssets=[]]  Additional file paths to include as release assets
 * @param {boolean}  [opts.dryRun=false]
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

/**
 * Run a git/gh command with execFileSync, returning stdout. Throws on non-zero exit.
 */
function runFile(prog, args, opts = {}) {
  return execFileSync(prog, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, ...opts }).trim();
}

/**
 * Check if a git tag already exists locally or on remote.
 */
function tagExists(kitDir, tag) {
  try {
    runFile('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd: kitDir,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
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
  runFile('git', ['tag', tag], { cwd: kitDir });
  runFile('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: kitDir });
  console.log(`  [tag] Created and pushed: ${tag}`);
}

/**
 * Format a commit subject for display, stripping the conventional commit prefix.
 * "feat(dots-core): add new system" → "add new system"
 */
function formatCommitSubject(subject) {
  const match = subject.match(/^[a-z]+(?:\([^)]+\))?!?\s*:\s*(.+)$/);
  return match ? match[1] : subject;
}

/**
 * Build the release notes body listing changed modules with per-module changelogs.
 */
function buildReleaseNotes(kitName, releaseTag, moduleAssets, manifestSummary, affectedModules) {
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

  // Per-module changelogs
  if (affectedModules && affectedModules.size > 0) {
    lines.push('', '### Changelog', '');
    for (const { name } of moduleAssets) {
      const commits = affectedModules.get(name);
      if (!commits || commits.length === 0) continue;

      lines.push(`#### ${name}`);
      // Group by type
      const grouped = {};
      for (const c of commits) {
        const label = c.breaking ? 'Breaking Changes'
          : c.type === 'feat' ? 'Features'
          : c.type === 'fix' ? 'Bug Fixes'
          : c.type === 'refactor' ? 'Refactors'
          : c.type === 'perf' ? 'Performance'
          : 'Other';
        if (!grouped[label]) grouped[label] = [];
        grouped[label].push(c);
      }
      for (const [label, items] of Object.entries(grouped)) {
        lines.push(`- **${label}:**`);
        for (const c of items) {
          const short = c.hash.substring(0, 7);
          lines.push(`  - ${formatCommitSubject(c.subject)} (${short})`);
        }
      }
      lines.push('');
    }
  }

  lines.push('### Assets', '', '- `manifest.json` — module index with versions and dependency ranges');
  for (const { name, version } of moduleAssets) {
    lines.push(`- \`${name}-${version}.zip\``);
  }
  return lines.join('\n');
}

/**
 * Create the GitHub Release with all assets attached.
 */
function createGithubRelease({ releaseTag, kitName, kitRepo, kitDir, manifestPath, moduleAssets, affectedModules, extraAssets = [], dryRun = false }) {
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

  const notes = buildReleaseNotes(kitName, releaseTag, moduleAssets, manifestSummary, affectedModules);
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

  // Build gh release create args — no shell interpolation
  const allAssetPaths = [
    manifestPath,
    ...moduleAssets.filter(a => a.zipPath).map(a => a.zipPath),
    ...extraAssets.filter(p => fs.existsSync(p)),
  ];

  const notesFile = path.join(path.dirname(manifestPath), '_release-notes.tmp.md');
  fs.writeFileSync(notesFile, notes);

  try {
    runFile(
      'gh',
      ['release', 'create', releaseTag, ...allAssetPaths, '--repo', kitRepo, '--title', title, '--notes-file', notesFile],
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
