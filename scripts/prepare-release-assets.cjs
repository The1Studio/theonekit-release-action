/**
 * prepare-release-assets.cjs
 * Generates metadata.json and bundles a ZIP for GitHub Release.
 *
 * Env:
 *   KIT_NAME     — display name (e.g. "TheOneKit Unity")
 *   ZIP_NAME     — output ZIP filename (e.g. "theonekit-unity.zip")
 *   ZIP_INCLUDES — space-separated paths to include (default: ".claude/")
 *   GITHUB_REPO  — owner/repo (e.g. "The1Studio/theonekit-unity")
 *   MODULES_FILE — path to t1k-modules.json (optional; enables module metadata)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const KIT_NAME = process.env.KIT_NAME;
const ZIP_NAME = process.env.ZIP_NAME;
const GITHUB_REPO = process.env.GITHUB_REPO || PKG.repository?.url?.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] || 'unknown/unknown';
const ZIP_INCLUDES = (process.env.ZIP_INCLUDES || '.claude/').trim().split(/\s+/).filter(Boolean);
const MODULES_FILE = process.env.MODULES_FILE || '';

if (!KIT_NAME) { console.error('[X] KIT_NAME env var not set'); process.exit(1); }
if (!ZIP_NAME) { console.error('[X] ZIP_NAME env var not set'); process.exit(1); }

// Step 1: Compute cumulative auto-deletions across ALL previous tags vs HEAD.
// Uses all tags (not just the previous one) so users upgrading from any version
// (e.g., v1 → v3 skipping v2) still get all orphaned files cleaned up.
function computeDeletions() {
  try {
    // Get all release tags sorted by version
    const tagsRaw = execSync('git tag --sort=-v:refname 2>/dev/null', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();

    if (!tagsRaw) return [];
    const tags = tagsRaw.split('\n').filter(Boolean);
    console.log(`[deletions] Scanning ${tags.length} tag(s) for cumulative deletions`);

    // Collect all .claude/ files that ever existed across all tags
    const allPrevFiles = new Set();
    for (const tag of tags) {
      try {
        const files = execSync(`git ls-tree -r --name-only ${tag} -- .claude/`, {
          cwd: ROOT,
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .filter((f) => f && f !== '.claude/metadata.json');
        for (const f of files) allPrevFiles.add(f);
      } catch {
        // Skip tags that don't have .claude/ directory
      }
    }

    // List .claude/ files at HEAD
    const currentFiles = new Set(
      execSync('git ls-tree -r --name-only HEAD -- .claude/', {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(Boolean),
    );

    // Find removed files (strip .claude/ prefix — deletions are relative to .claude/)
    const removed = [...allPrevFiles]
      .filter((f) => !currentFiles.has(f))
      .map((f) => f.replace(/^\.claude\//, ''));

    if (removed.length === 0) return [];

    // Optimize: if all files in a directory are removed, use glob pattern
    const dirCounts = {};
    for (const file of removed) {
      const dir = path.dirname(file);
      if (dir !== '.') {
        dirCounts[dir] = (dirCounts[dir] || 0) + 1;
      }
    }

    // Check if entire directories were removed
    const optimized = new Set();
    const handledByGlob = new Set();

    for (const [dir, count] of Object.entries(dirCounts)) {
      // Count how many files existed in this dir at previous tag
      const dirPrefix = `.claude/${dir}/`;
      const prevDirFiles = [...allPrevFiles].filter((f) => f.startsWith(dirPrefix));
      if (count === prevDirFiles.length && count > 1) {
        optimized.add(`${dir}/**`);
        for (const file of removed) {
          if (file.startsWith(`${dir}/`)) handledByGlob.add(file);
        }
      }
    }

    // Add individual files not covered by glob patterns
    for (const file of removed) {
      if (!handledByGlob.has(file)) optimized.add(file);
    }

    const result = [...optimized].sort();
    console.log(`[deletions] Found ${result.length} deletion(s): ${result.join(', ')}`);
    return result;
  } catch {
    // First release or git error — no deletions needed
    console.log('[deletions] No previous tag found, skipping deletion computation');
    return [];
  }
}

const deletions = computeDeletions();

// Step 2a: Read module info (modular kits only)
function readModulesInfo() {
  if (!MODULES_FILE) return null;
  const modulesPath = path.join(ROOT, MODULES_FILE);
  if (!fs.existsSync(modulesPath)) {
    console.log(`[modules] ${MODULES_FILE} not found — treating as flat kit`);
    return null;
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
  } catch (e) {
    console.error(`[modules] Failed to parse ${MODULES_FILE}: ${e.message}`);
    process.exit(1);
  }
  const mods = registry.modules || {};
  const info = {
    hasModules: true,
    moduleCount: Object.keys(mods).length,
    presetCount: Object.keys(registry.presets || {}).length,
    modules: Object.entries(mods).map(([name, mod]) => ({
      name,
      ...(mod.version && { version: mod.version }),
      ...(mod.required !== undefined && { required: mod.required }),
    })),
  };
  console.log(`[modules] Detected modular kit: ${info.moduleCount} module(s), ${info.presetCount} preset(s)`);
  return info;
}

// Step 2b: Copy t1k-modules.json into .claude/ so it's included in ZIP
function copyModulesFile() {
  if (!MODULES_FILE) return;
  const src = path.join(ROOT, MODULES_FILE);
  if (!fs.existsSync(src)) return;
  const dst = path.join(ROOT, '.claude', 't1k-modules.json');
  fs.copyFileSync(src, dst);
  console.log(`[modules] Copied ${MODULES_FILE} → .claude/t1k-modules.json`);
}

const modulesInfo = readModulesInfo();
copyModulesFile();

// Step 2c: Flatten module files (modular kits only)
if (modulesInfo) {
  const { flattenModuleFiles } = require('./flatten-module-files.cjs');
  const result = flattenModuleFiles(path.join(ROOT, '.claude'));
  console.log(`[flatten] Flattened ${result.flattenedCount} file(s) from ${result.moduleCount} module(s)`);
}

// Step 3: Update metadata.json (with auto-computed deletions and optional module info)
const kitSlug = KIT_NAME.toLowerCase().replace(/\s+/g, '-');
const metadata = {
  name: kitSlug,
  version: PKG.version,
  buildDate: new Date().toISOString(),
  repository: GITHUB_REPO,
  ...(modulesInfo && { hasModules: true, moduleCount: modulesInfo.moduleCount, modules: modulesInfo.modules }),
  ...(deletions.length > 0 && { deletions }),
};

const claudeDir = path.join(ROOT, '.claude');
if (fs.existsSync(claudeDir)) {
  const metadataPath = path.join(claudeDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(`[metadata] Updated ${metadataPath} → v${PKG.version}`);
} else {
  console.log('[metadata] No .claude/ directory — skipping metadata.json (non-kit repo)');
}

// Step 4: Create dist/ directory
if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

// Step 5: Bundle ZIP
const zipPath = path.join(DIST, ZIP_NAME);
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Files/dirs to exclude
const excludes = [
  'node_modules/*',
  '.git/*',
  '.venv/*',
  'dist/*',
  'scripts/*',
  'plans/reports/*',
  '*.log',
  '__pycache__/*',
];

const excludeArgs = excludes.map((e) => `-x '${e}'`).join(' ');
const includeArgs = ZIP_INCLUDES.join(' ');

// Check if any included paths exist before trying to ZIP
const existingIncludes = ZIP_INCLUDES.filter((p) => fs.existsSync(path.join(ROOT, p)));
if (existingIncludes.length === 0) {
  console.log(`[bundle] No includable paths found (${ZIP_INCLUDES.join(', ')}). Skipping ZIP.`);
} else {
  const includeArgs = existingIncludes.join(' ');
  console.log(`[bundle] Including: ${includeArgs}`);

  try {
    execSync(`cd "${ROOT}" && zip -r "${zipPath}" ${includeArgs} ${excludeArgs}`, {
      stdio: 'inherit',
    });
    const stats = fs.statSync(zipPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`[bundle] Created ${zipPath} (${sizeMB} MB)`);
  } catch (err) {
    console.error('[bundle] Failed to create ZIP:', err.message);
    process.exit(1);
  }
}

console.log('[done] Release assets ready');
