/**
 * inject-origin-metadata.cjs
 * Injects origin/module/protected frontmatter into .claude/ files during release.
 *
 * For .md files (skills, agents, rules):
 *   - Adds/updates `origin:`, `module:`, `protected:` in YAML frontmatter
 *
 * For .json files (registry, config):
 *   - Adds/updates `_origin` top-level key
 *
 * Env:
 *   GITHUB_REPO  — owner/repo (e.g. "The1Studio/theonekit-unity")
 *   CORE_REPO    — core repo name for protected file detection (default: "theonekit-core")
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CLAUDE_DIR = path.join(ROOT, '.claude');
const GITHUB_REPO = process.env.GITHUB_REPO || 'unknown/unknown';
const CORE_REPO = process.env.CORE_REPO || 'theonekit-core';
const KIT_NAME = GITHUB_REPO.split('/').pop(); // e.g. "theonekit-unity"

if (!fs.existsSync(CLAUDE_DIR)) {
  console.log('[origin] No .claude/ directory — skipping');
  process.exit(0);
}

let mdCount = 0;
let jsonCount = 0;

/**
 * Determine module name from file path.
 * Files in .claude/modules/<name>/... → module = <name>
 * Files elsewhere → module = null
 */
function getModuleName(filePath) {
  const rel = path.relative(CLAUDE_DIR, filePath);
  const match = rel.match(/^modules\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Inject frontmatter fields into a markdown file.
 * Creates frontmatter if missing; updates existing fields.
 */
function injectMdMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const moduleName = getModuleName(filePath);

  // Parse existing frontmatter
  let hasFrontmatter = content.startsWith('---\n');
  let frontmatter = {};
  let body = content;

  if (hasFrontmatter) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const fmBlock = content.substring(4, endIdx);
      body = content.substring(endIdx + 5);

      // Parse YAML-like frontmatter preserving multi-line block scalars (| and >)
      const fmLines = fmBlock.split('\n');
      let currentKey = null;
      let currentLines = [];

      for (const line of fmLines) {
        const isIndented = line.startsWith(' ') || line.startsWith('\t');
        if (!isIndented) {
          // Flush previous key
          if (currentKey) {
            frontmatter[currentKey] = currentLines.join('\n');
          }
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            currentKey = line.substring(0, colonIdx).trim();
            currentLines = [line.substring(colonIdx + 1).trimStart()];
          } else {
            currentKey = null;
            currentLines = [];
          }
        } else if (currentKey) {
          // Indented line belongs to current block scalar
          currentLines.push(line);
        }
      }
      // Flush last key
      if (currentKey) {
        frontmatter[currentKey] = currentLines.join('\n');
      }
    }
  }

  // Set origin metadata fields
  const metaKeys = ['origin', 'module', 'protected'];
  frontmatter['origin'] = KIT_NAME;
  frontmatter['module'] = moduleName || 'null';
  frontmatter['protected'] = KIT_NAME === CORE_REPO ? 'true' : 'false';

  // Rebuild frontmatter: preserve original raw lines, append/update origin fields
  // Strategy: re-parse original block to preserve exact formatting, then replace/append meta keys
  let rawFmBlock = '';
  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      rawFmBlock = content.substring(4, endIdx);
    }
  }

  // Remove existing origin/module/protected lines from raw block
  const cleanedLines = [];
  const rawLines = rawFmBlock.split('\n');
  let skipIndented = false;
  for (const line of rawLines) {
    const isIndented = line.startsWith(' ') || line.startsWith('\t');
    if (!isIndented) {
      skipIndented = false;
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        if (metaKeys.includes(key)) {
          skipIndented = true; // skip any indented continuation lines too
          continue;
        }
      }
    } else if (skipIndented) {
      continue;
    }
    cleanedLines.push(line);
  }

  // Append origin metadata at end
  cleanedLines.push(`origin: ${frontmatter['origin']}`);
  cleanedLines.push(`module: ${frontmatter['module']}`);
  cleanedLines.push(`protected: ${frontmatter['protected']}`);

  const newContent = `---\n${cleanedLines.join('\n')}\n---\n${body}`;
  fs.writeFileSync(filePath, newContent);
  mdCount++;
}

/**
 * Inject _origin key into a JSON file.
 */
function injectJsonMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    console.log(`[origin] Skipping invalid JSON: ${path.relative(ROOT, filePath)}`);
    return;
  }

  const moduleName = getModuleName(filePath);

  data._origin = {
    kit: KIT_NAME,
    module: moduleName || null,
    protected: KIT_NAME === CORE_REPO,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  jsonCount++;
}

/**
 * Recursively walk directory and process files.
 */
function walkDir(dir) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, .git, dist, etc.
      if (['node_modules', '.git', 'dist', '__pycache__', '.venv'].includes(entry.name)) continue;
      walkDir(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();

      if (ext === '.md') {
        injectMdMetadata(fullPath);
      } else if (ext === '.json') {
        // Skip metadata.json (generated separately) and package.json
        if (entry.name === 'metadata.json' || entry.name === 'package.json') continue;
        injectJsonMetadata(fullPath);
      }
    }
  }
}

// Run
console.log(`[origin] Injecting metadata for kit: ${KIT_NAME}`);
walkDir(CLAUDE_DIR);
console.log(`[origin] Done — ${mdCount} .md files, ${jsonCount} .json files updated`);
