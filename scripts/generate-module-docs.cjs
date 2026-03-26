/**
 * generate-module-docs.cjs
 * Auto-generates module documentation for modular kits during the release pipeline.
 *
 * Creates:
 *   docs/module-system.md  — kit-wide module overview
 *   docs/modules/{name}.md — per-module documentation
 *
 * Env:
 *   MODULES_FILE — path to t1k-modules.json (default: 't1k-modules.json')
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_FILE = process.env.MODULES_FILE || 't1k-modules.json';
const modulesPath = path.join(ROOT, MODULES_FILE);

if (!fs.existsSync(modulesPath)) {
  console.log('[docs] No modules file found — skipping doc generation');
  process.exit(0);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
} catch (e) {
  console.error(`[docs] Failed to parse ${MODULES_FILE}: ${e.message}`);
  process.exit(1);
}

const kitName = registry.kitName;
const modules = registry.modules || {};
const presets = registry.presets || {};
const moduleNames = Object.keys(modules);

if (!kitName || moduleNames.length === 0) {
  console.log('[docs] No kitName or modules — skipping');
  process.exit(0);
}

console.log(`[docs] Generating docs for ${kitName} (${moduleNames.length} modules)`);

/**
 * Parse YAML frontmatter from a markdown file. Returns { name, description }.
 */
function parseFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('---\n')) return {};

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return {};

  const block = content.substring(4, endIdx);
  const result = {};

  for (const line of block.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.substring(0, colonIdx).trim();
    if (key !== 'name' && key !== 'description') continue;
    let val = line.substring(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Block scalar (| or >) — read next non-empty indented line
    if (val === '|' || val === '>') {
      const lines = block.split('\n');
      const lineIdx = lines.indexOf(line);
      for (let i = lineIdx + 1; i < lines.length; i++) {
        const next = lines[i];
        if ((next.startsWith(' ') || next.startsWith('\t')) && next.trim()) {
          val = next.trim();
          break;
        }
        if (!next.startsWith(' ') && !next.startsWith('\t')) break;
      }
    }
    result[key] = val;
  }

  return result;
}

/**
 * Find a file trying flat (.claude/) then nested (modules/) locations.
 */
function findFile(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Read activation keywords for a module.
 */
function readKeywords(modName, mod) {
  const fragName = mod.activationFragment;
  if (!fragName) return [];

  const fragPath = findFile([
    path.join(ROOT, '.claude', fragName),
    path.join(ROOT, '.claude', 'modules', modName, fragName),
    path.join(ROOT, 'modules', modName, fragName),
  ]);
  if (!fragPath) return [];

  try {
    const frag = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
    const kws = new Set();
    for (const m of (frag.mappings || [])) {
      for (const kw of (m.keywords || [])) kws.add(kw);
    }
    return [...kws].sort();
  } catch {
    return [];
  }
}

/**
 * Get skill info: { name, description } for each skill in a module.
 */
function getSkillInfos(modName, mod) {
  const skills = mod.skills || [];
  const infos = [];

  for (const skill of skills) {
    const skillMd = findFile([
      path.join(ROOT, '.claude', 'skills', skill, 'SKILL.md'),
      path.join(ROOT, '.claude', 'modules', modName, 'skills', skill, 'SKILL.md'),
      path.join(ROOT, 'modules', modName, 'skills', skill, 'SKILL.md'),
    ]);
    if (!skillMd) {
      console.warn(`[docs] Warning: SKILL.md not found for "${skill}" — skipping`);
      continue;
    }
    const fm = parseFrontmatter(skillMd);
    infos.push({ name: skill, description: (fm && fm.description) || '' });
  }

  return infos;
}

/**
 * Get agent info: { name, description } for each agent in a module.
 */
function getAgentInfos(modName, mod) {
  const agents = mod.agents || [];
  const infos = [];

  for (const agent of agents) {
    const agentMd = findFile([
      path.join(ROOT, '.claude', 'agents', agent),
      path.join(ROOT, '.claude', 'modules', modName, 'agents', agent),
      path.join(ROOT, 'modules', modName, 'agents', agent),
    ]);
    if (!agentMd) continue;
    const fm = parseFrontmatter(agentMd);
    infos.push({ name: agent.replace(/\.md$/, ''), description: (fm && fm.description) || '' });
  }

  return infos;
}

// ── Generate docs/module-system.md ────────────────────────────────────────────

const docsDir = path.join(ROOT, 'docs');
const modulesDocsDir = path.join(docsDir, 'modules');
fs.mkdirSync(modulesDocsDir, { recursive: true });

const overviewLines = [
  `# ${kitName} Module System`,
  '',
  '<!-- auto-generated by theonekit-release-action — do not edit manually -->',
  '',
  '## Modules',
  '',
  '| Module | Required | Skills | Agents | Dependencies |',
  '|--------|----------|--------|--------|--------------|',
];

for (const [name, mod] of Object.entries(modules)) {
  const req = mod.required ? 'yes' : 'no';
  const skillCount = (mod.skills || []).length;
  const agentCount = (mod.agents || []).length;
  const deps = (mod.dependencies || []).length > 0 ? mod.dependencies.join(', ') : '\u2014';
  overviewLines.push(`| ${name} | ${req} | ${skillCount} | ${agentCount} | ${deps} |`);
}

const presetNames = Object.keys(presets);
if (presetNames.length > 0) {
  overviewLines.push('', '## Presets', '', '| Preset | Modules |', '|--------|---------|');
  for (const [pName, pVal] of Object.entries(presets)) {
    const mods = pVal === '*' ? 'all' : (Array.isArray(pVal) ? pVal.join(', ') : (pVal?.modules || []).join(', '));
    overviewLines.push(`| ${pName} | ${mods} |`);
  }
}

overviewLines.push('');
fs.writeFileSync(path.join(docsDir, 'module-system.md'), overviewLines.join('\n'));
console.log('[docs] Written → docs/module-system.md');

// ── Generate docs/modules/{name}.md per module ───────────────────────────────

for (const [name, mod] of Object.entries(modules)) {
  const lines = [
    `# ${name}`,
    '',
    '<!-- auto-generated by theonekit-release-action — do not edit manually -->',
    '',
    `**Kit:** ${kitName} | **Required:** ${mod.required ? 'yes' : 'no'} | **Dependencies:** ${(mod.dependencies || []).length > 0 ? mod.dependencies.join(', ') : 'none'}`,
    '',
  ];

  // Skills
  const skillInfos = getSkillInfos(name, mod);
  lines.push('## Skills', '');
  if (skillInfos.length > 0) {
    lines.push('| Skill | Description |', '|-------|-------------|');
    for (const s of skillInfos) {
      lines.push(`| ${s.name} | ${s.description} |`);
    }
  } else {
    lines.push('No skills');
  }
  lines.push('');

  // Agents
  const agentInfos = getAgentInfos(name, mod);
  if (agentInfos.length > 0) {
    lines.push('## Agents', '', '| Agent | Description |', '|-------|-------------|');
    for (const a of agentInfos) {
      lines.push(`| ${a.name} | ${a.description} |`);
    }
    lines.push('');
  }

  // Keywords
  const keywords = readKeywords(name, mod);
  lines.push('## Activation Keywords', '');
  lines.push(keywords.length > 0 ? keywords.join(', ') : 'No activation keywords');
  lines.push('');

  fs.writeFileSync(path.join(modulesDocsDir, `${name}.md`), lines.join('\n'));
  console.log(`[docs] Written → docs/modules/${name}.md`);
}

console.log(`[docs] Done — ${moduleNames.length} module doc(s) + overview generated`);
