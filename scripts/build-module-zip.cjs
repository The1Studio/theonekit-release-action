/**
 * build-module-zip.cjs
 * Build a per-module ZIP: flatten files, generate manifest, zip.
 *
 * Origin metadata is NOT injected here — it is injected into the repo by
 * release-modules.cjs (step 3b) before ZIPs are built, so files are already
 * transformed when staged into the ZIP.
 *
 * ZIP structure:
 *   .claude/
 *     skills/{skill-name}/...
 *     agents/{agent-file}
 *     t1k-activation-{module}.json
 *     t1k-routing-{kit}-{module}.json
 *     modules/{module-name}/.t1k-manifest.json
 *
 * @param {object} opts
 * @param {string}   opts.moduleName        e.g. "dots-core"
 * @param {string}   opts.version           e.g. "2.2.0"
 * @param {string}   opts.kitName           e.g. "theonekit-unity"
 * @param {string}   opts.kitRepo           e.g. "The1Studio/theonekit-unity"
 * @param {object}   opts.moduleEntry       Entry from t1k-modules.json .modules[name]
 * @param {string}   opts.kitDir            Absolute path to kit repo root
 * @param {string}   opts.outputDir         Directory to write the ZIP into
 * @param {boolean}  [opts.dryRun=false]    If true, skip ZIP creation
 * @returns {{ zipPath: string, manifest: object }}
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { generateManifestFromList, writeManifest } = require('./generate-module-manifest.cjs');

/**
 * Copy src -> dst, creating parent dirs as needed.
 */
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * Recursively copy a directory tree src -> dst.
 * Returns list of relative paths (relative to dst base) that were copied.
 */
function copyDir(src, dstBase, relPrefix, collected) {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dstBase, rel);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstBase, rel, collected);
    } else {
      copyFile(srcPath, dstPath);
      collected.push(rel);
    }
  }
}

/**
 * Stage all module files into a temp directory mirroring .claude/ layout.
 * Returns list of .claude/-relative paths staged.
 */
function stageModuleFiles(moduleName, moduleEntry, moduleSourceDir, stagingClaudeDir) {
  const claudeRelPaths = [];

  // --- Skills (check module dir first, then flat .claude/skills/) ---
  const kitClaudeDir = path.resolve(moduleSourceDir, '..');
  for (const skillName of (moduleEntry.skills || [])) {
    // Priority: modules/{name}/skills/ > .claude/skills/ (flat)
    let src = path.join(moduleSourceDir, 'skills', skillName);
    if (!fs.existsSync(src)) src = path.join(kitClaudeDir, 'skills', skillName);
    const dstBase = path.join(stagingClaudeDir, 'skills', skillName);
    const collected = [];
    copyDir(src, dstBase, '', collected);
    for (const f of collected) {
      claudeRelPaths.push(`skills/${skillName}/${f}`);
    }
    if (collected.length > 0) {
      console.log(`  [stage] skills/${skillName} (${collected.length} file(s))`);
    } else {
      console.warn(`  [stage] warn: skills/${skillName} not found or empty`);
    }
  }

  // --- Agents (check module dir first, then flat .claude/agents/) ---
  for (const agentFile of (moduleEntry.agents || [])) {
    let src = path.join(moduleSourceDir, 'agents', agentFile);
    if (!fs.existsSync(src)) src = path.join(kitClaudeDir, 'agents', agentFile);
    if (!fs.existsSync(src)) {
      console.warn(`  [stage] warn: agents/${agentFile} not found`);
      continue;
    }
    const dst = path.join(stagingClaudeDir, 'agents', agentFile);
    copyFile(src, dst);
    claudeRelPaths.push(`agents/${agentFile}`);
    console.log(`  [stage] agents/${agentFile}`);
  }

  // --- Activation fragment (check module dir first, then .claude/) ---
  if (moduleEntry.activationFragment) {
    let src = path.join(moduleSourceDir, moduleEntry.activationFragment);
    if (!fs.existsSync(src)) src = path.join(kitClaudeDir, moduleEntry.activationFragment);
    if (fs.existsSync(src)) {
      const dst = path.join(stagingClaudeDir, moduleEntry.activationFragment);
      copyFile(src, dst);
      claudeRelPaths.push(moduleEntry.activationFragment);
      console.log(`  [stage] ${moduleEntry.activationFragment}`);
    }
  }

  // --- Routing overlay (check module dir first, then .claude/) ---
  if (moduleEntry.routingOverlay) {
    let src = path.join(moduleSourceDir, moduleEntry.routingOverlay);
    if (!fs.existsSync(src)) src = path.join(kitClaudeDir, moduleEntry.routingOverlay);
    if (fs.existsSync(src)) {
      const dst = path.join(stagingClaudeDir, moduleEntry.routingOverlay);
      copyFile(src, dst);
      claudeRelPaths.push(moduleEntry.routingOverlay);
      console.log(`  [stage] ${moduleEntry.routingOverlay}`);
    }
  }

  return claudeRelPaths;
}

/**
 * Create a ZIP from the staging dir using the system zip command.
 * zipPath is the output file (absolute).
 */
function createZip(stagingDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  // Use -r (recursive), -q (quiet), paths relative to stagingDir
  execSync(`zip -r -q "${zipPath}" .`, {
    cwd: stagingDir,
    stdio: 'inherit',
  });
  const stats = fs.statSync(zipPath);
  console.log(`  [zip] ${path.basename(zipPath)} (${(stats.size / 1024).toFixed(1)} KB)`);
}

/**
 * Build a per-module ZIP.
 */
function buildModuleZip({ moduleName, version, kitName, kitRepo, moduleEntry, kitDir, outputDir, dryRun = false }) {
  console.log(`\n[build-zip] ${moduleName}@${version}`);

  const moduleSourceDir = path.join(kitDir, '.claude', 'modules', moduleName);
  if (!fs.existsSync(moduleSourceDir)) {
    throw new Error(`Module source directory not found: ${moduleSourceDir}`);
  }

  // Create temp staging dir
  const stagingDir = path.join(outputDir, `_stage_${moduleName}`);
  const stagingClaudeDir = path.join(stagingDir, '.claude');
  fs.mkdirSync(stagingClaudeDir, { recursive: true });

  try {
    // Stage kit-wide shared files (.gitignore, etc.) — needed for consumer project hygiene
    const kitClaudeDir = path.join(kitDir, '.claude');
    const sharedFiles = ['.gitignore'];
    for (const shared of sharedFiles) {
      const src = path.join(kitClaudeDir, shared);
      if (fs.existsSync(src)) {
        const dst = path.join(stagingClaudeDir, shared);
        copyFile(src, dst);
        console.log(`  [stage] ${shared} (kit-wide shared)`);
      }
    }

    // Stage files (origin metadata already injected into repo by release-modules.cjs step 3b)
    const stagedPaths = stageModuleFiles(moduleName, moduleEntry, moduleSourceDir, stagingClaudeDir);

    // Generate manifest
    const manifest = generateManifestFromList({ moduleName, version, kitName, files: stagedPaths });
    writeManifest(stagingClaudeDir, moduleName, manifest);

    if (dryRun) {
      console.log(`  [dry-run] would create: ${moduleName}-${version}.zip (${stagedPaths.length} file(s) + manifest)`);
      return { zipPath: null, manifest };
    }

    // Create ZIP
    const zipPath = path.join(outputDir, `${moduleName}-${version}.zip`);
    createZip(stagingDir, zipPath);

    return { zipPath, manifest };
  } finally {
    // Clean up staging dir
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = { buildModuleZip };
