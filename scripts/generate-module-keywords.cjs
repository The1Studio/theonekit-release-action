/**
 * generate-module-keywords.cjs
 * Generates t1k-modules-keywords-{kit}.json from all module activation fragments.
 * This file is included in the release ZIP and used by the UserPromptSubmit hook
 * to warn users about keywords from modules they haven't installed.
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
  console.error(`[X] ${MODULES_FILE} not found at ${modulesPath}`);
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
} catch (e) {
  console.error(`[X] Failed to parse ${MODULES_FILE}: ${e.message}`);
  process.exit(1);
}

const kitName = registry.kitName;
const modules = registry.modules || {};

if (!kitName) {
  console.error('[X] kitName not found in t1k-modules.json');
  process.exit(1);
}

console.log(`[keywords] Generating keyword map for kit: ${kitName}`);
console.log(`[keywords] Processing ${Object.keys(modules).length} module(s)...`);

// Build keyword map: { moduleName: string[] }
const keywordMap = {};

for (const [modName, mod] of Object.entries(modules)) {
  const keywords = new Set();

  // Read activation fragment if declared
  if (mod.activationFragment) {
    const fragPath = path.join(ROOT, '.claude', mod.activationFragment);
    if (fs.existsSync(fragPath)) {
      let frag;
      try {
        frag = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
      } catch (e) {
        console.warn(`[keywords] Warning: could not parse ${mod.activationFragment}: ${e.message}`);
        frag = null;
      }

      if (frag && Array.isArray(frag.mappings)) {
        for (const mapping of frag.mappings) {
          for (const kw of (mapping.keywords || [])) {
            keywords.add(kw);
          }
        }
      }
    } else {
      console.warn(`[keywords] Warning: activationFragment not found: .claude/${mod.activationFragment}`);
    }
  }

  // Also scan skills directory for SKILL.md keyword hints (best-effort)
  if (mod.skills && Array.isArray(mod.skills)) {
    for (const skillName of mod.skills) {
      // Skill name itself as a keyword (lowercase, split by dash/underscore)
      const parts = skillName.replace(/^(unity|cocos|rn|t1k)-/, '').split(/[-_]/);
      for (const part of parts) {
        if (part.length > 2) keywords.add(part);
      }
    }
  }

  if (keywords.size > 0) {
    keywordMap[modName] = [...keywords].sort();
    console.log(`[keywords]   ${modName}: ${keywords.size} keyword(s)`);
  } else {
    keywordMap[modName] = [];
    console.log(`[keywords]   ${modName}: no keywords found`);
  }
}

// Write output to .claude/
const outputFileName = `t1k-modules-keywords-${kitName}.json`;
const outputPath = path.join(ROOT, '.claude', outputFileName);

const output = {
  _generated: new Date().toISOString(),
  _kitName: kitName,
  _moduleCount: Object.keys(modules).length,
  keywords: keywordMap,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(`[keywords] Written → .claude/${outputFileName}`);
console.log(`[keywords] Done — ${Object.keys(keywordMap).length} module(s) mapped`);
