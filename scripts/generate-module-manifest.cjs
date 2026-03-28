/**
 * generate-module-manifest.cjs
 * Generate .t1k-manifest.json for a module during ZIP build.
 *
 * The manifest tracks every file the module installs into .claude/, enabling
 * deterministic install, update (diff old vs new), and remove operations.
 *
 * Schema:
 * {
 *   "module": "dots-core",
 *   "version": "2.2.0",
 *   "kit": "theonekit-unity",
 *   "generatedBy": "release-action",
 *   "generatedAt": "<iso>",
 *   "files": {
 *     "skills":    ["dots-ecs-core/SKILL.md", ...],   // relative to .claude/skills/
 *     "agents":    ["dots-implementer.md", ...],       // relative to .claude/agents/
 *     "fragments": ["t1k-activation-dots-core.json"],  // relative to .claude/
 *     "other":     []                                  // relative to .claude/
 *   },
 *   "checksum": "sha256:<hex>"
 * }
 *
 * All paths are relative to .claude/ so the consumer can resolve them to disk.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Walk a directory recursively, returning relative file paths.
 * @param {string} dir  Absolute base directory to walk.
 * @param {string} [base]  Internal: current relative prefix (default '').
 * @returns {string[]}  Sorted list of relative paths (using forward slashes).
 */
function walkRelative(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkRelative(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results.sort();
}

/**
 * Categorize a list of .claude/-relative file paths into the manifest groups.
 *
 * @param {string[]} files  Paths relative to .claude/ (e.g. "skills/foo/SKILL.md")
 * @returns {{ skills: string[], agents: string[], fragments: string[], other: string[] }}
 */
function categorizeFiles(files) {
  const skills = [];
  const agents = [];
  const fragments = [];
  const other = [];

  for (const f of files) {
    if (f.startsWith('skills/')) {
      // Strip the leading "skills/" prefix — path is relative to .claude/skills/
      skills.push(f.slice('skills/'.length));
    } else if (f.startsWith('agents/')) {
      agents.push(f.slice('agents/'.length));
    } else if (/^t1k-[a-z].*\.json$/.test(f)) {
      fragments.push(f);
    } else {
      other.push(f);
    }
  }

  return { skills, agents, fragments, other };
}

/**
 * Compute SHA-256 checksum of a JSON-serialisable object.
 * Serialises with sorted keys for determinism.
 */
function checksumObject(obj) {
  // Exclude "checksum" field itself from the hash
  const { checksum: _ignored, ...rest } = obj;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort(), 2);
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Generate the manifest for one module.
 *
 * @param {object} opts
 * @param {string} opts.moduleName   Module name (e.g. "dots-core")
 * @param {string} opts.version      Current version (e.g. "2.2.0")
 * @param {string} opts.kitName      Parent kit (e.g. "theonekit-unity")
 * @param {string} opts.claudeDir    Absolute path to the .claude/ staging dir.
 *
 * The function inspects the staged .claude/ tree for files that belong to this
 * module by reading the skills/agents/fragment lists from the manifest data
 * already present in the module's flat output under claudeDir.
 *
 * @returns {object}  The manifest object (not yet written to disk).
 */
function generateManifest({ moduleName, version, kitName, claudeDir }) {
  // Collect all .claude/-relative paths that belong to this module.
  // Heuristic: skills named in the module registry (passed via moduleEntry),
  // agents, and fragment files whose name contains the module name.
  //
  // For a flat ZIP (all modules already merged), we rely on caller passing
  // the explicit file list instead. This default path collects everything.
  const allFiles = walkRelative(claudeDir).filter(f => {
    // Skip manifest files themselves and metadata.json to avoid circular refs
    return !f.endsWith('/manifest.json') && f !== 'metadata.json';
  });

  const categorized = categorizeFiles(allFiles);

  const manifest = {
    module: moduleName,
    version,
    kit: kitName,
    generatedBy: 'release-action',
    generatedAt: new Date().toISOString(),
    files: categorized,
    checksum: '',
  };

  manifest.checksum = checksumObject(manifest);
  return manifest;
}

/**
 * Generate a manifest from an explicit file list (used by build-module-zip.cjs
 * which knows exactly which files belong to this module).
 *
 * @param {object} opts
 * @param {string}   opts.moduleName
 * @param {string}   opts.version
 * @param {string}   opts.kitName
 * @param {string[]} opts.files  .claude/-relative paths (e.g. ["skills/foo/SKILL.md"])
 * @returns {object}
 */
function generateManifestFromList({ moduleName, version, kitName, files }) {
  const categorized = categorizeFiles(files.sort());

  const manifest = {
    module: moduleName,
    version,
    kit: kitName,
    generatedBy: 'release-action',
    generatedAt: new Date().toISOString(),
    files: categorized,
    checksum: '',
  };

  manifest.checksum = checksumObject(manifest);
  return manifest;
}

/**
 * Write a manifest object to disk at the standard location:
 *   <claudeDir>/modules/<moduleName>/.t1k-manifest.json
 *
 * Creates parent directories as needed.
 *
 * @param {string} claudeDir
 * @param {string} moduleName
 * @param {object} manifest
 */
function writeManifest(claudeDir, moduleName, manifest) {
  const dir = path.join(claudeDir, 'modules', moduleName);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, '.t1k-manifest.json');
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[manifest] Written: modules/${moduleName}/.t1k-manifest.json (${manifest.files.skills.length} skills, ${manifest.files.agents.length} agents, ${manifest.files.fragments.length} fragments)`);
  return dest;
}

module.exports = { generateManifest, generateManifestFromList, writeManifest, categorizeFiles, walkRelative };
