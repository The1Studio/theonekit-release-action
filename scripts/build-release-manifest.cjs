/**
 * build-release-manifest.cjs
 * Generate manifest.json — the release index listing all modules with versions,
 * deps, and ZIP asset filenames. Included as a GitHub Release asset.
 *
 * Output schema:
 * {
 *   "kit": "theonekit-unity",
 *   "repository": "The1Studio/theonekit-unity",
 *   "releasedAt": "<iso>",
 *   "releaseTag": "modules-20260327-1200",
 *   "modules": {
 *     "unity-base": {
 *       "version": "1.0.0",
 *       "required": true,
 *       "asset": "unity-base-1.0.0.zip",
 *       "checksum": "sha256:abc123...",
 *       "dependencies": {}
 *     },
 *     "dots-core": {
 *       "version": "2.2.0",
 *       "required": false,
 *       "asset": "dots-core-2.2.0.zip",
 *       "checksum": "sha256:def456...",
 *       "dependencies": { "unity-base": ">=1.0.0" }
 *     }
 *   }
 * }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Read module.json from a module directory.
 * Returns null if not found or invalid.
 *
 * @param {string} moduleDir  Absolute path to modules/{name}/ directory.
 * @returns {object|null}
 */
function readModuleJson(moduleDir) {
  const p = path.join(moduleDir, 'module.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[manifest] warn: could not parse ${p}: ${e.message}`);
    return null;
  }
}

/**
 * Build the release manifest.json from all module.json files in the kit.
 *
 * @param {object} opts
 * @param {string} opts.kitName          e.g. "theonekit-unity"
 * @param {string} opts.kitRepo          e.g. "The1Studio/theonekit-unity"
 * @param {string} opts.releaseTag       e.g. "modules-20260327-1200"
 * @param {string} opts.kitDir           Absolute path to kit repo root.
 * @param {string} opts.outputPath       Absolute path to write manifest.json.
 * @param {object} [opts.moduleChecksums] Map of moduleName → "sha256:<hex>" strings.
 * @param {boolean} [opts.dryRun]
 * @returns {object}  The manifest object.
 */
function buildReleaseManifest({ kitName, kitRepo, releaseTag, kitDir, outputPath, moduleChecksums = {}, dryRun = false }) {
  const modulesRootDir = path.join(kitDir, '.claude', 'modules');

  if (!fs.existsSync(modulesRootDir)) {
    throw new Error(`modules directory not found: ${modulesRootDir}`);
  }

  const moduleDirs = fs.readdirSync(modulesRootDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  if (moduleDirs.length === 0) {
    throw new Error(`No module directories found under ${modulesRootDir}`);
  }

  const modules = {};

  for (const modName of moduleDirs) {
    const moduleDir = path.join(modulesRootDir, modName);
    const modJson = readModuleJson(moduleDir);

    if (!modJson) {
      console.warn(`[manifest] warn: no module.json for "${modName}" — skipping`);
      continue;
    }

    const version = modJson.version || '0.0.0';
    modules[modName] = {
      version,
      required: modJson.required === true,
      asset: `${modName}-${version}.zip`,
      ...(moduleChecksums[modName] && { checksum: moduleChecksums[modName] }),
      dependencies: modJson.dependencies || {},
    };

    if (modJson.crossKitDependencies && Object.keys(modJson.crossKitDependencies).length > 0) {
      modules[modName].crossKitDependencies = modJson.crossKitDependencies;
    }

    console.log(`[manifest] ${modName}@${version} (required: ${modules[modName].required})`);
  }

  const manifest = {
    kit: kitName,
    repository: kitRepo,
    releasedAt: new Date().toISOString(),
    releaseTag,
    modules,
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`[manifest] Written to ${outputPath} (${Object.keys(modules).length} module(s))`);
  } else {
    console.log(`[manifest] dry-run — would write ${Object.keys(modules).length} module(s) to ${outputPath}`);
  }

  return manifest;
}

module.exports = { buildReleaseManifest, readModuleJson };
