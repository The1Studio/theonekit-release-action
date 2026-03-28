/**
 * inject-origin-metadata.cjs
 * Injects origin/module/protected metadata into ALL .claude/ files during release.
 *
 * Supported file types:
 *   .md          — YAML frontmatter (origin, repository, module, protected)
 *   .json        — top-level `_origin` key
 *   .cjs, .js    — `// t1k-origin: ...` comment header
 *   .sh, .py     — `# t1k-origin: ...` comment header
 *   .yml, .yaml  — `# t1k-origin: ...` comment header
 *
 * Skipped files:
 *   metadata.json  — generated separately by prepare-release-assets.cjs
 *   package.json   — npm manifest, not a kit file
 *   settings.json  — intentionally skipped: user-configurable file, injecting
 *                    _origin into it would break Claude Code's settings parsing
 *
 * Env:
 *   GITHUB_REPO   — owner/repo (e.g. "The1Studio/theonekit-unity")
 *   CORE_REPO     — core repo name for protected file detection (default: "theonekit-core")
 *   MODULES_FILE  — path to t1k-modules.json (optional; enables skill→module lookup)
 *   MODULE_NAME   — if set, scope injection to files belonging to this module only
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CLAUDE_DIR = path.join(ROOT, '.claude');
const GITHUB_REPO = process.env.GITHUB_REPO || 'unknown/unknown';
const CORE_REPO = process.env.CORE_REPO || 'theonekit-core';
const MODULES_FILE = process.env.MODULES_FILE || '';
const MODULE_NAME = process.env.MODULE_NAME || '';  // if set, scope injection to this module only
const KIT_NAME = GITHUB_REPO.split('/').pop(); // e.g. "theonekit-unity"

if (!fs.existsSync(CLAUDE_DIR)) {
  console.log('[origin] No .claude/ directory — skipping');
  process.exit(0);
}

let mdCount = 0;
let jsonCount = 0;
let commentCount = 0;

/**
 * Build a skill→module lookup map from t1k-modules.json.
 *
 * For modular kits, skills are flattened from:
 *   .claude/modules/{module}/skills/{skill}/
 * to:
 *   .claude/skills/{skill}/
 *
 * When inject-origin-metadata runs before flattening, skills are still in
 * modules/{module}/skills/ and getModuleName() detects the module from the path.
 * When inject runs after flattening (or for future-proofing), skills sit at
 * .claude/skills/ with no module path context — this lookup map resolves them.
 *
 * Returns: Map<skillName, moduleName> or empty map for flat kits.
 */
function buildSkillModuleMap() {
  const map = new Map();

  // Prefer MODULES_FILE env var (set by workflow when modular=true)
  let modulesPath = '';
  if (MODULES_FILE) {
    modulesPath = path.isAbsolute(MODULES_FILE)
      ? MODULES_FILE
      : path.join(ROOT, MODULES_FILE);
  } else {
    // Fallback: check standard locations
    const candidates = [
      path.join(ROOT, 't1k-modules.json'),
      path.join(CLAUDE_DIR, 't1k-modules.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        modulesPath = c;
        break;
      }
    }
  }

  if (!modulesPath || !fs.existsSync(modulesPath)) {
    return map; // flat kit — no lookup needed
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
  } catch (e) {
    console.warn(`[origin] warn: could not parse ${modulesPath}: ${e.message} — module lookup disabled`);
    return map;
  }

  const modules = registry.modules || {};
  for (const [moduleName, mod] of Object.entries(modules)) {
    for (const skillName of (mod.skills || [])) {
      map.set(skillName, moduleName);
    }
  }

  console.log(`[origin] Module lookup map built: ${map.size} skill(s) across ${Object.keys(modules).length} module(s)`);
  return map;
}

const SKILL_MODULE_MAP = buildSkillModuleMap();

/**
 * Determine module name for a file path.
 *
 * Resolution order:
 *  1. Path-based: file is inside modules/{name}/ → use {name} directly
 *  2. Skill lookup: file is inside skills/{name}/ → look up in SKILL_MODULE_MAP
 *  3. Fallback: null (kit-wide file or core)
 */
function getModuleName(filePath) {
  const rel = path.relative(CLAUDE_DIR, filePath);

  // 1. Path-based detection (pre-flatten layout: modules/{module}/skills/...)
  const moduleMatch = rel.match(/^modules\/([^/]+)\//);
  if (moduleMatch) return moduleMatch[1];

  // 2. Skill lookup (post-flatten layout: skills/{skill}/...)
  const skillMatch = rel.match(/^skills\/([^/]+)\//);
  if (skillMatch) {
    const skillName = skillMatch[1];
    if (SKILL_MODULE_MAP.has(skillName)) {
      return SKILL_MODULE_MAP.get(skillName);
    }
  }

  // 3. Kit-wide file (rules/, agents/ at root, JSON fragments, etc.)
  return null;
}

/**
 * Inject frontmatter fields into a markdown file.
 * Creates frontmatter if missing; updates existing fields.
 * Always injects all 4 fields: origin, repository, module, protected.
 */
function injectMdMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const moduleName = getModuleName(filePath);

  // Parse existing frontmatter
  let hasFrontmatter = content.startsWith('---\n');
  let body = content;
  let rawFmBlock = '';

  if (hasFrontmatter) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      rawFmBlock = content.substring(4, endIdx);
      body = content.substring(endIdx + 5);
    }
  }

  // Remove existing origin metadata lines from raw block
  const metaKeys = ['origin', 'repository', 'module', 'protected'];
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

  // Append all 4 origin metadata fields at end
  const isProtected = KIT_NAME === CORE_REPO ? 'true' : 'false';
  cleanedLines.push(`origin: ${KIT_NAME}`);
  cleanedLines.push(`repository: ${GITHUB_REPO}`);
  cleanedLines.push(`module: ${moduleName !== null ? moduleName : 'null'}`);
  cleanedLines.push(`protected: ${isProtected}`);

  const newContent = `---\n${cleanedLines.join('\n')}\n---\n${body}`;
  fs.writeFileSync(filePath, newContent);
  mdCount++;
}

/**
 * Inject _origin key into a JSON file.
 * Always injects all 4 fields: kit, repository, module, protected.
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
    repository: GITHUB_REPO,
    module: moduleName,
    protected: KIT_NAME === CORE_REPO,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  jsonCount++;
}

/**
 * Inject origin comment header into script/config files (.cjs, .js, .sh, .py, .yml, .yaml).
 * Uses `// t1k-origin:` for JS or `# t1k-origin:` for shell/python/yaml.
 * Replaces existing t1k-origin line if present; otherwise prepends (after shebang if any).
 * Always injects all 4 fields: kit, repo, module, protected.
 */
function injectCommentMetadata(filePath, commentPrefix) {
  const content = fs.readFileSync(filePath, 'utf8');
  const moduleName = getModuleName(filePath);
  const isProtected = KIT_NAME === CORE_REPO;

  const originLine = `${commentPrefix} t1k-origin: kit=${KIT_NAME} | repo=${GITHUB_REPO} | module=${moduleName !== null ? moduleName : 'null'} | protected=${isProtected}`;

  // Remove existing t1k-origin line if present
  const lines = content.split('\n');
  const filtered = lines.filter(l => !l.includes('t1k-origin:'));

  // Insert after shebang (if present), otherwise at top
  let insertIdx = 0;
  if (filtered.length > 0 && filtered[0].startsWith('#!')) {
    insertIdx = 1;
  }
  filtered.splice(insertIdx, 0, originLine);

  fs.writeFileSync(filePath, filtered.join('\n'));
  commentCount++;
}

/**
 * When MODULE_NAME is set, determine if a file belongs to that module.
 * Matches:
 *   - Files under modules/{MODULE_NAME}/ (pre-flatten layout)
 *   - Skills under skills/{skillName}/ where skillName maps to MODULE_NAME
 *   - Activation fragment / routing overlay paths referenced by the module
 *
 * Returns true if the file should be processed, false to skip.
 * When MODULE_NAME is not set, always returns true (process all files).
 */
function isInTargetModule(filePath) {
  if (!MODULE_NAME) return true;

  const rel = path.relative(CLAUDE_DIR, filePath);

  // Pre-flatten layout: modules/{MODULE_NAME}/...
  if (rel.startsWith(`modules/${MODULE_NAME}/`) || rel === `modules/${MODULE_NAME}`) {
    return true;
  }

  // Post-flatten layout: skill in skills/ that belongs to MODULE_NAME
  const skillMatch = rel.match(/^skills\/([^/]+)\//);
  if (skillMatch) {
    return SKILL_MODULE_MAP.get(skillMatch[1]) === MODULE_NAME;
  }

  // Activation fragment or routing overlay: check against module entry in registry
  if (SKILL_MODULE_MAP.size > 0) {
    // Reload registry to check fragment/overlay paths for the target module
    // (SKILL_MODULE_MAP is already built from the same registry file)
    // We rely on naming convention: t1k-activation-{module}.json or t1k-routing-{kit}-{module}.json
    const basename = path.basename(filePath);
    const moduleSlug = MODULE_NAME.replace(/[^a-z0-9]/gi, '-');
    if (basename.includes(moduleSlug)) return true;
  }

  return false;
}

/** File extension → comment prefix mapping */
const COMMENT_EXTENSIONS = {
  '.cjs': '//',
  '.js': '//',
  '.mjs': '//',
  '.sh': '#',
  '.py': '#',
  '.yml': '#',
  '.yaml': '#',
};

/**
 * JSON files that are intentionally skipped:
 *   - metadata.json  — generated separately by prepare-release-assets.cjs
 *   - package.json   — npm manifest
 *   - settings.json  — user-configurable Claude Code settings; injecting _origin
 *                      would break Claude Code's settings parsing and override
 *                      user customizations on install
 */
const SKIP_JSON_FILES = new Set(['metadata.json', 'package.json', 'settings.json']);

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
      // When MODULE_NAME is set, skip files that don't belong to the target module
      if (!isInTargetModule(fullPath)) continue;

      const ext = path.extname(entry.name).toLowerCase();

      if (ext === '.md') {
        injectMdMetadata(fullPath);
      } else if (ext === '.json') {
        if (SKIP_JSON_FILES.has(entry.name)) continue;
        injectJsonMetadata(fullPath);
      } else if (ext in COMMENT_EXTENSIONS) {
        injectCommentMetadata(fullPath, COMMENT_EXTENSIONS[ext]);
      }
    }
  }
}

// Run
console.log(`[origin] Injecting metadata for kit: ${KIT_NAME}`);
if (MODULE_NAME) {
  console.log(`[origin] Scoped injection — target module: ${MODULE_NAME}`);
}
if (SKILL_MODULE_MAP.size > 0) {
  console.log(`[origin] Module-aware injection enabled (${SKILL_MODULE_MAP.size} skill mappings loaded)`);
} else {
  console.log('[origin] Flat kit or no MODULES_FILE — module field will be null for all non-module paths');
}
walkDir(CLAUDE_DIR);
console.log(`[origin] Done — ${mdCount} .md, ${jsonCount} .json, ${commentCount} script/config files updated`);
