/**
 * release-modules.cjs
 * Orchestrator for per-module releases. Replaces semantic-release for modular kits.
 *
 * Steps:
 *   1.  Discover modules + read t1k-modules.json registry
 *   1b. Sync t1k-modules.json and activation fragments from module.json (SSOT)
 *   2.  Parse conventional commits since last release tag
 *   3.  Compute per-module semver bumps, write updated module.json files
 *   3b. Inject origin metadata into repo .claude/ (commit-back pipeline)
 *   3c. Auto-prefix agents for cross-kit uniqueness
 *   3d. Validate no collisions within this kit
 *   3e. Commit all transformations (metadata + prefixes + versions) to git
 *   4.  Build per-module ZIPs from transformed git state
 *   5.  Build release manifest.json
 *   6.  Create GitHub Release with all assets + per-module tags
 *
 * Usage:
 *   node release-modules.cjs --kit-dir /path/to/kit-repo [--dry-run]
 *
 * Env:
 *   GITHUB_REPO  — owner/repo (auto-detected from git remote if absent)
 *   KIT_NAME     — display name (e.g. "TheOneKit Unity")
 *   GITHUB_TOKEN — required by gh CLI in CI
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { analyzeCommits }                          = require('./parse-commits.cjs');
const { computeBumpType, applyBump }              = require('./compute-version-bump.cjs');
const { buildModuleZip }                          = require('./build-module-zip.cjs');
const { buildReleaseManifest, readModuleJson }    = require('./build-release-manifest.cjs');
const { createGithubRelease }                     = require('./create-github-release.cjs');
const {
  resolveKitRepo,
  readModulesRegistry,
  listModuleNames,
  buildReleaseTag,
  commitVersionBumps,
  commitTransformations,
} = require('./release-modules-helpers.cjs');

const { execSync } = require('child_process');

const INJECT_SCRIPT    = path.join(__dirname, 'inject-origin-metadata.cjs');
const PREFIX_SCRIPT    = path.join(__dirname, 'auto-prefix-agents.cjs');
const VALIDATE_SCRIPT  = path.join(__dirname, 'validate-no-collisions.cjs');

/**
 * Run a script via node, inheriting stdio, with the given env overrides.
 * Throws on non-zero exit.
 */
function runScript(scriptPath, cwd, envOverrides = {}) {
  execSync(`node "${scriptPath}"`, {
    cwd,
    env: { ...process.env, ...envOverrides },
    stdio: 'inherit',
  });
}

// ── SSOT sync helpers ─────────────────────────────────────────────────────────

/**
 * Regenerate the `modules` section of t1k-modules.json from individual module.json files.
 * module.json is the SSOT for per-module metadata; t1k-modules.json.modules is generated.
 *
 * Also regenerates t1k-activation-{module}.json from module.json `activation` fields.
 *
 * Preserves: kitName, registryVersion, presets (hand-authored).
 */
function syncModulesRegistry(moduleNames, modulesDir, claudeDir, dryRun) {
  const registryPath = path.join(claudeDir, 't1k-modules.json');
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    console.warn(`[release] warn: could not read t1k-modules.json for sync: ${e.message}`);
    return;
  }

  const generatedModules = {};

  for (const modName of moduleNames) {
    const modJson = readModuleJson(path.join(modulesDir, modName));
    if (!modJson) {
      console.warn(`[release] warn: no module.json for "${modName}" — skipping sync`);
      continue;
    }

    // Build t1k-modules.json module entry from module.json (stripping version, kit, name fields)
    generatedModules[modName] = {
      description:        modJson.description || '',
      required:           modJson.required || false,
      // Convert object deps {modName: semverRange} → string array for backward compat
      dependencies:       Array.isArray(modJson.dependencies)
                            ? modJson.dependencies
                            : Object.keys(modJson.dependencies || {}),
      skills:             modJson.skills || [],
      ...(modJson.agents?.length    ? { agents: modJson.agents }                     : {}),
      ...(modJson.activation        ? { activationFragment: `t1k-activation-${modName}.json` } : {}),
      ...(modJson.routingOverlay    ? { routingOverlay: modJson.routingOverlay }      : {}),
    };

    // Regenerate t1k-activation-{module}.json from module.json activation field
    if (modJson.activation) {
      syncActivationFragment(modName, modJson, registry.kitName, claudeDir, dryRun);
    }
  }

  // Write back with generated marker on modules section
  const updated = {
    registryVersion:  registry.registryVersion,
    kitName:          registry.kitName,
    _modulesGeneratedFrom: 'module.json files — edit modules/*/module.json instead',
    modules:          generatedModules,
    presets:          registry.presets,
  };

  if (!dryRun) {
    fs.writeFileSync(registryPath, JSON.stringify(updated, null, 2) + '\n');
    console.log(`[release] Synced t1k-modules.json modules section from ${moduleNames.length} module.json files`);
  } else {
    console.log(`[release] dry-run: would sync t1k-modules.json from module.json files`);
  }
}

/**
 * Generate t1k-activation-{module}.json from module.json activation field.
 * module.json activation is the SSOT; the activation fragment file is generated.
 */
function syncActivationFragment(modName, modJson, kitName, claudeDir, dryRun) {
  const activation = modJson.activation;
  if (!activation) return;

  const fragPath = path.join(claudeDir, `t1k-activation-${modName}.json`);
  const fragment = {
    _generatedFrom: `module.json activation field — edit modules/${modName}/module.json instead`,
    registryVersion: 1,
    kitName,
    priority: 91,  // module-level priority base
    ...(activation.sessionBaseline?.length ? { sessionBaseline: activation.sessionBaseline } : {}),
    mappings: activation.mappings || [],
  };

  if (!dryRun) {
    fs.writeFileSync(fragPath, JSON.stringify(fragment, null, 2) + '\n');
    console.log(`[release]   Generated t1k-activation-${modName}.json`);
  } else {
    console.log(`[release] dry-run: would generate t1k-activation-${modName}.json`);
  }
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const kitDirArg = args[args.indexOf('--kit-dir') + 1];
const dryRun    = args.includes('--dry-run');

if (!kitDirArg) {
  console.error('[release] Usage: node release-modules.cjs --kit-dir <path> [--dry-run]');
  process.exit(1);
}

const KIT_DIR    = path.resolve(kitDirArg);
const CLAUDE_DIR = path.join(KIT_DIR, '.claude');
const MODULES_DIR = path.join(CLAUDE_DIR, 'modules');

if (!fs.existsSync(KIT_DIR)) {
  console.error(`[release] Kit directory not found: ${KIT_DIR}`);
  process.exit(1);
}

// ── Version bump phase ────────────────────────────────────────────────────────

/**
 * For each module: compute bump from commits, update module.json if changed.
 * Returns { moduleVersions: Map, bumpedModules: string[] }.
 */
function applyVersionBumps(moduleNames, registry, affectedModules, breakingAll) {
  const moduleVersions = {};
  const bumpedModules  = [];

  for (const modName of moduleNames) {
    const modJsonPath = path.join(MODULES_DIR, modName, 'module.json');
    const modJson     = readModuleJson(path.join(MODULES_DIR, modName));

    if (!modJson) {
      console.warn(`[release] warn: no module.json for "${modName}" — using 0.0.0`);
      moduleVersions[modName] = '0.0.0';
      continue;
    }

    const commits = affectedModules.get(modName) || [];
    let bump = computeBumpType(commits);
    // Global breaking change forces major on all modules
    if (breakingAll) bump = 'major';

    const current = modJson.version || '0.0.0';
    const next    = bump !== 'none' ? applyBump(current, bump) : current;
    moduleVersions[modName] = next;

    if (next !== current) {
      console.log(`[release] ${modName}: ${current} -> ${next} (${bump})`);
      if (!dryRun) {
        modJson.version = next;
        fs.writeFileSync(modJsonPath, JSON.stringify(modJson, null, 2) + '\n');
      }
      bumpedModules.push(modName);
    } else {
      console.log(`[release] ${modName}: ${current} (no change)`);
    }
  }

  return { moduleVersions, bumpedModules };
}

// ── ZIP build phase ───────────────────────────────────────────────────────────

/**
 * Build per-module ZIPs for all modules into outputDir.
 * Returns array of { name, version, zipPath, manifest }.
 */
function buildAllZips(moduleNames, registry, moduleVersions, kitName, kitRepo, outputDir) {
  const assets = [];

  for (const modName of moduleNames) {
    const moduleEntry = registry.modules?.[modName];
    if (!moduleEntry) {
      console.warn(`[release] warn: ${modName} not in t1k-modules.json — skipping ZIP`);
      continue;
    }

    const version = moduleVersions[modName] || '0.0.0';
    const { zipPath, manifest } = buildModuleZip({
      moduleName:  modName,
      version,
      kitName,
      kitRepo,
      moduleEntry,
      kitDir:      KIT_DIR,
      outputDir,
      dryRun,
    });

    assets.push({ name: modName, version, zipPath, manifest });
  }

  return assets;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('[release] TheOneKit Module Release');
  console.log(`[release] Kit dir: ${KIT_DIR}`);
  if (dryRun) console.log('[release] DRY RUN — no files will be written or pushed');
  console.log('='.repeat(60));

  // Step 1: Discover modules
  const registry       = readModulesRegistry(CLAUDE_DIR);
  const kitName        = registry.kitName || path.basename(KIT_DIR);
  const kitDisplayName = process.env.KIT_NAME || kitName;
  const kitRepo        = resolveKitRepo(KIT_DIR);
  const moduleNames    = listModuleNames(MODULES_DIR);

  if (moduleNames.length === 0) {
    console.log('[release] No modules found — nothing to release');
    process.exit(0);
  }
  console.log(`\n[release] ${moduleNames.length} module(s): ${moduleNames.join(', ')}`);

  // Step 1b: Sync t1k-modules.json and activation fragments from module.json (SSOT)
  // module.json is authoritative; t1k-modules.json.modules and t1k-activation-*.json are generated.
  syncModulesRegistry(moduleNames, MODULES_DIR, CLAUDE_DIR, dryRun);

  // Reload registry after sync to get freshly generated data
  const syncedRegistry = dryRun ? registry : readModulesRegistry(CLAUDE_DIR);

  // Step 2: Analyze commits
  const { affectedModules, breakingAll, hasChanges, lastTag } =
    analyzeCommits(KIT_DIR, moduleNames, kitName);

  if (!hasChanges && lastTag) {
    console.log('\n[release] No releasable commits since last tag — exiting');
    process.exit(0);
  }

  // Step 3: Bump versions
  const { moduleVersions, bumpedModules } =
    applyVersionBumps(moduleNames, syncedRegistry, affectedModules, breakingAll);

  // Step 3b: Inject origin metadata into .claude/ in-repo (not just ZIPs)
  console.log('\n[release] Step 3b: Inject origin metadata into repo .claude/');
  if (!dryRun) {
    const modulesFile = path.join(CLAUDE_DIR, 't1k-modules.json');
    runScript(INJECT_SCRIPT, KIT_DIR, {
      GITHUB_REPO:  kitRepo,
      CORE_REPO:    process.env.CORE_REPO || 'theonekit-core',
      MODULES_FILE: fs.existsSync(modulesFile) ? modulesFile : '',
    });
  } else {
    console.log('[release] dry-run: would inject origin metadata into .claude/');
  }

  // Step 3c: Auto-prefix agents for uniqueness
  console.log('\n[release] Step 3c: Auto-prefix agents');
  if (!dryRun) {
    const modulesFile = path.join(CLAUDE_DIR, 't1k-modules.json');
    runScript(PREFIX_SCRIPT, KIT_DIR, {
      GITHUB_REPO:   kitRepo,
      CORE_REPO:     process.env.CORE_REPO || 'theonekit-core',
      MODULES_FILE:  fs.existsSync(modulesFile) ? modulesFile : '',
    });
  } else {
    console.log('[release] dry-run: would auto-prefix agents in .claude/agents/');
  }

  // Step 3d: Validate — no collisions within this kit
  console.log('\n[release] Step 3d: Validate no collisions');
  if (!dryRun) {
    const modulesFile = path.join(CLAUDE_DIR, 't1k-modules.json');
    runScript(VALIDATE_SCRIPT, KIT_DIR, {
      GITHUB_REPO:  kitRepo,
      CORE_REPO:    process.env.CORE_REPO || 'theonekit-core',
      MODULES_FILE: fs.existsSync(modulesFile) ? modulesFile : '',
    });
  } else {
    console.log('[release] dry-run: would run validate-no-collisions');
  }

  // Step 3e: Commit all transformations (metadata + prefixes + versions + synced files)
  console.log('\n[release] Step 3e: Commit all transformations to git');
  commitTransformations(KIT_DIR, dryRun);

  // Step 4: Build ZIPs from current (transformed) git state
  const outputDir = dryRun
    ? path.join(os.tmpdir(), `t1k-release-dry-${Date.now()}`)
    : path.join(KIT_DIR, 'dist', 'modules');
  fs.mkdirSync(outputDir, { recursive: true });

  // Reload registry after transformations (agent renames may have updated t1k-modules.json)
  const finalRegistry = dryRun ? syncedRegistry : readModulesRegistry(CLAUDE_DIR);

  const moduleAssets = buildAllZips(moduleNames, finalRegistry, moduleVersions, kitName, kitRepo, outputDir);

  // Step 5: Build release manifest.json
  const releaseTag   = buildReleaseTag();
  const manifestPath = path.join(outputDir, 'manifest.json');
  buildReleaseManifest({ kitName, kitRepo, releaseTag, kitDir: KIT_DIR, outputPath: manifestPath, dryRun });

  // Step 5b: Collect extra release assets (keyword file, etc.)
  const extraAssets = [];
  const keywordFile = path.join(CLAUDE_DIR, `t1k-modules-keywords-${kitName}.json`);
  if (fs.existsSync(keywordFile)) {
    const dst = path.join(outputDir, path.basename(keywordFile));
    if (!dryRun) fs.copyFileSync(keywordFile, dst);
    extraAssets.push(dst);
    console.log(`[release] Including keyword file: ${path.basename(keywordFile)}`);
  }

  // Step 6: Create GitHub Release + per-module tags (with per-module changelogs)
  createGithubRelease({ releaseTag, kitName: kitDisplayName, kitRepo, kitDir: KIT_DIR, manifestPath, moduleAssets, affectedModules, extraAssets, dryRun });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[release] Done — ${moduleAssets.length} module(s) released as ${releaseTag}`);
  if (dryRun) console.log('[release] DRY RUN complete — no changes persisted');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error(`\n[release] FATAL: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
