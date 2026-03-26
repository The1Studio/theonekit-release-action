/**
 * flatten-module-files.cjs
 * Flattens module-scoped skills, agents, and activation fragments into the
 * .claude/ root so the installer sees them as kit-wide files.
 *
 * Called by prepare-release-assets.cjs after copyModulesFile().
 *
 * @param {string} claudeDir  Absolute path to the .claude/ directory.
 * @returns {{ flattenedCount: number, moduleCount: number }}
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Copy a file, creating parent directories as needed.
 * Returns true if copied, false if source does not exist (with a warning).
 */
function copyFile(src, dst, tag) {
  if (!fs.existsSync(src)) {
    console.warn(`[${tag}] warn: source not found, skipping: ${src}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

/**
 * Recursively copy a directory tree from src to dst.
 * Returns the number of files copied.
 */
function copyDirRecursive(src, dst, tag) {
  if (!fs.existsSync(src)) {
    console.warn(`[${tag}] warn: source directory not found, skipping: ${src}`);
    return 0;
  }
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcEntry = path.join(src, entry.name);
    const dstEntry = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcEntry, dstEntry, tag);
    } else {
      fs.mkdirSync(path.dirname(dstEntry), { recursive: true });
      fs.copyFileSync(srcEntry, dstEntry);
      count++;
    }
  }
  return count;
}

/**
 * Remove a directory and all its contents recursively.
 */
function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  // Node 14.14+ supports fs.rmSync with recursive option
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Check whether a path is owned by a module (i.e., it originated inside
 * modules/{moduleName}/). Used for collision detection.
 */
function isModulePath(filePath) {
  return filePath.includes(`${path.sep}modules${path.sep}`) || filePath.startsWith(`modules${path.sep}`);
}

/**
 * Flatten all modules defined in t1k-modules.json into the .claude/ root.
 *
 * @param {string} claudeDir  Absolute path to the .claude/ directory.
 * @returns {{ flattenedCount: number, moduleCount: number }}
 */
function flattenModuleFiles(claudeDir) {
  const modulesRegistryPath = path.join(claudeDir, 't1k-modules.json');

  if (!fs.existsSync(modulesRegistryPath)) {
    console.log('[flatten] No t1k-modules.json found — skipping (flat kit)');
    return { flattenedCount: 0, moduleCount: 0 };
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(modulesRegistryPath, 'utf8'));
  } catch (e) {
    console.error(`[flatten] Failed to parse t1k-modules.json: ${e.message}`);
    process.exit(1);
  }

  const kitName = registry.kitName || 'unknown';
  const modules = registry.modules || {};
  const moduleNames = Object.keys(modules);

  if (moduleNames.length === 0) {
    console.log('[flatten] t1k-modules.json has no modules — skipping');
    return { flattenedCount: 0, moduleCount: 0 };
  }

  console.log(`[flatten] Kit: ${kitName} — flattening ${moduleNames.length} module(s)`);

  let totalFlattened = 0;

  for (const moduleName of moduleNames) {
    const mod = modules[moduleName];
    const moduleDir = path.join(claudeDir, 'modules', moduleName);
    const tag = `flatten:${moduleName}`;
    const manifestFiles = [];

    // --- Skills ---
    const skills = mod.skills || [];
    if (skills.length > 0) {
      for (const skillName of skills) {
        const srcSkillDir = path.join(moduleDir, 'skills', skillName);
        const dstSkillDir = path.join(claudeDir, 'skills', skillName);

        // Collision detection: warn if destination already exists and is NOT from a module
        if (fs.existsSync(dstSkillDir) && !isModulePath(srcSkillDir)) {
          // The source is clearly from a module path — check if dst has no module lineage
          console.warn(
            `[${tag}] warn: skills/${skillName} already exists in .claude/skills/ — overwriting`,
          );
        }

        const copied = copyDirRecursive(srcSkillDir, dstSkillDir, tag);
        if (copied > 0) {
          console.log(`[${tag}] skills/${skillName} → .claude/skills/${skillName} (${copied} file(s))`);
          totalFlattened += copied;
          manifestFiles.push(`skills/${skillName}`);
        }
      }
    } else {
      console.log(`[${tag}] no skills — skipping skills copy`);
    }

    // --- Agents ---
    const agents = mod.agents || [];
    if (agents.length > 0) {
      for (const agentFile of agents) {
        const srcAgent = path.join(moduleDir, 'agents', agentFile);
        const dstAgent = path.join(claudeDir, 'agents', agentFile);

        // Collision detection: warn if destination already exists
        if (fs.existsSync(dstAgent)) {
          console.warn(`[${tag}] warn: agents/${agentFile} already exists — overwriting`);
        }

        const copied = copyFile(srcAgent, dstAgent, tag);
        if (copied) {
          console.log(`[${tag}] agents/${agentFile} → .claude/agents/${agentFile}`);
          totalFlattened++;
          manifestFiles.push(`agents/${agentFile}`);
        }
      }
    } else {
      console.log(`[${tag}] no agents — skipping agents copy`);
    }

    // --- Activation fragment ---
    if (mod.activationFragment) {
      const srcFrag = path.join(moduleDir, mod.activationFragment);
      const dstFrag = path.join(claudeDir, mod.activationFragment);

      if (fs.existsSync(dstFrag)) {
        console.warn(`[${tag}] warn: ${mod.activationFragment} already exists at root — overwriting`);
      }

      const copied = copyFile(srcFrag, dstFrag, tag);
      if (copied) {
        console.log(`[${tag}] ${mod.activationFragment} → .claude/${mod.activationFragment}`);
        totalFlattened++;
        manifestFiles.push(mod.activationFragment);
      }
    }

    // --- Routing overlay ---
    if (mod.routingOverlay) {
      const srcOverlay = path.join(moduleDir, mod.routingOverlay);
      const dstOverlay = path.join(claudeDir, mod.routingOverlay);

      if (fs.existsSync(dstOverlay)) {
        console.warn(`[${tag}] warn: ${mod.routingOverlay} already exists at root — overwriting`);
      }

      const copied = copyFile(srcOverlay, dstOverlay, tag);
      if (copied) {
        console.log(`[${tag}] ${mod.routingOverlay} → .claude/${mod.routingOverlay}`);
        totalFlattened++;
        manifestFiles.push(mod.routingOverlay);
      }
    }

    // --- Generate manifest.json ---
    const manifest = {
      module: moduleName,
      kit: kitName,
      generatedBy: 'release-action',
      generatedAt: new Date().toISOString(),
      files: manifestFiles,
    };
    const manifestPath = path.join(moduleDir, 'manifest.json');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`[${tag}] manifest.json written (${manifestFiles.length} tracked file(s))`);

    // --- Strip nested originals ---
    const skillsDir = path.join(moduleDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      rmDirRecursive(skillsDir);
      console.log(`[${tag}] removed modules/${moduleName}/skills/`);
    }

    const agentsDir = path.join(moduleDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      rmDirRecursive(agentsDir);
      console.log(`[${tag}] removed modules/${moduleName}/agents/`);
    }

    if (mod.activationFragment) {
      const srcFrag = path.join(moduleDir, mod.activationFragment);
      if (fs.existsSync(srcFrag)) {
        fs.unlinkSync(srcFrag);
        console.log(`[${tag}] removed modules/${moduleName}/${mod.activationFragment}`);
      }
    }

    if (mod.routingOverlay) {
      const srcOverlay = path.join(moduleDir, mod.routingOverlay);
      if (fs.existsSync(srcOverlay)) {
        fs.unlinkSync(srcOverlay);
        console.log(`[${tag}] removed modules/${moduleName}/${mod.routingOverlay}`);
      }
    }
  }

  console.log(`[flatten] Done — ${totalFlattened} file(s) flattened from ${moduleNames.length} module(s)`);
  return { flattenedCount: totalFlattened, moduleCount: moduleNames.length };
}

module.exports = { flattenModuleFiles };
