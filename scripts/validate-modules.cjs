/**
 * validate-modules.cjs
 * Validates t1k-modules.json for modular kits before release.
 *
 * Env:
 *   MODULES_FILE — path to t1k-modules.json (default: 't1k-modules.json')
 *
 * Exit 0 = all checks pass
 * Exit 1 = any check fails (blocks release)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_FILE = process.env.MODULES_FILE || 't1k-modules.json';
const modulesPath = path.join(ROOT, MODULES_FILE);

let errors = 0;

function fail(msg) {
  console.error(`  [FAIL] ${msg}`);
  errors++;
}

function pass(msg) {
  console.log(`  [OK]   ${msg}`);
}

function warn(msg) {
  console.log(`  [WARN] ${msg}`);
}

// ── Check 1: File exists and parses ─────────────────────────────────────────
console.log('\n[validate] Checking t1k-modules.json...');

if (!fs.existsSync(modulesPath)) {
  fail(`${MODULES_FILE} not found at ${modulesPath}`);
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
  pass(`${MODULES_FILE} parses as valid JSON`);
} catch (e) {
  fail(`${MODULES_FILE} is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ── Check 2: Schema version ──────────────────────────────────────────────────
console.log('\n[validate] Checking schema version...');
if (registry.registryVersion !== 2) {
  fail(`registryVersion must be 2, got: ${registry.registryVersion}`);
} else {
  pass(`registryVersion: ${registry.registryVersion}`);
}

// ── Check 3: kitName present ─────────────────────────────────────────────────
if (!registry.kitName || typeof registry.kitName !== 'string') {
  fail('kitName is required and must be a string');
} else {
  pass(`kitName: ${registry.kitName}`);
}

// ── Check 4: modules object present ─────────────────────────────────────────
if (!registry.modules || typeof registry.modules !== 'object') {
  fail('modules must be a non-null object');
  process.exit(1);
}

const modules = registry.modules;
const moduleNames = Object.keys(modules);
console.log(`\n[validate] Found ${moduleNames.length} module(s): ${moduleNames.join(', ')}`);

// ── Check 5: Per-module file existence ──────────────────────────────────────
console.log('\n[validate] Checking per-module file existence...');

const skillsOwnership = {}; // skill -> module (for overlap detection)

for (const [name, mod] of Object.entries(modules)) {
  console.log(`\n  [module: ${name}]`);

  // Skills
  if (mod.skills && Array.isArray(mod.skills)) {
    for (const skill of mod.skills) {
      const skillDir = path.join(ROOT, '.claude', 'skills', skill);
      if (!fs.existsSync(skillDir)) {
        // Try as a direct file too
        const skillFile = path.join(ROOT, '.claude', 'skills', `${skill}.md`);
        if (!fs.existsSync(skillFile)) {
          fail(`Skill "${skill}" (module: ${name}) not found at .claude/skills/${skill}/`);
        } else {
          pass(`Skill "${skill}" exists (as file)`);
        }
      } else {
        pass(`Skill "${skill}" exists`);
      }
      // Track ownership for overlap check
      if (skillsOwnership[skill]) {
        fail(`Skill "${skill}" declared in both "${skillsOwnership[skill]}" and "${name}" (overlap)`);
      } else {
        skillsOwnership[skill] = name;
      }
    }
  }

  // Agents
  if (mod.agents && Array.isArray(mod.agents)) {
    for (const agent of mod.agents) {
      const agentPath = path.join(ROOT, '.claude', 'agents', agent);
      if (!fs.existsSync(agentPath)) {
        fail(`Agent "${agent}" (module: ${name}) not found at .claude/agents/${agent}`);
      } else {
        pass(`Agent "${agent}" exists`);
      }
    }
  }

  // Activation fragment
  if (mod.activationFragment) {
    const fragPath = path.join(ROOT, '.claude', mod.activationFragment);
    if (!fs.existsSync(fragPath)) {
      fail(`activationFragment "${mod.activationFragment}" (module: ${name}) not found at .claude/${mod.activationFragment}`);
    } else {
      pass(`activationFragment "${mod.activationFragment}" exists`);
    }
  }

  // Routing overlay
  if (mod.routingOverlay) {
    const overlayPath = path.join(ROOT, '.claude', mod.routingOverlay);
    if (!fs.existsSync(overlayPath)) {
      fail(`routingOverlay "${mod.routingOverlay}" (module: ${name}) not found at .claude/${mod.routingOverlay}`);
    } else {
      pass(`routingOverlay "${mod.routingOverlay}" exists`);
    }
  }
}

// ── Check 6: No duplicate activation keywords across modules ─────────────────
console.log('\n[validate] Checking activation keyword uniqueness...');

const keywordOwnership = {}; // keyword -> module
let kwConflicts = 0;

for (const [name, mod] of Object.entries(modules)) {
  if (!mod.activationFragment) continue;
  const fragPath = path.join(ROOT, '.claude', mod.activationFragment);
  if (!fs.existsSync(fragPath)) continue;

  let frag;
  try {
    frag = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
  } catch {
    warn(`Could not parse activation fragment for module "${name}" — skipping keyword check`);
    continue;
  }

  const mappings = frag.mappings || [];
  for (const mapping of mappings) {
    for (const kw of (mapping.keywords || [])) {
      const kwLower = kw.toLowerCase();
      if (keywordOwnership[kwLower]) {
        fail(`Keyword "${kw}" in module "${name}" also found in "${keywordOwnership[kwLower]}" (keyword conflict)`);
        kwConflicts++;
      } else {
        keywordOwnership[kwLower] = name;
      }
    }
  }
}

if (kwConflicts === 0) {
  pass(`No duplicate keywords across ${moduleNames.length} module activation fragments`);
}

// ── Check 7: Dependency references valid modules ─────────────────────────────
console.log('\n[validate] Checking dependency references...');

for (const [name, mod] of Object.entries(modules)) {
  const deps = mod.dependencies;
  if (!deps || typeof deps !== 'object') continue;

  for (const depName of Object.keys(deps)) {
    // Dependencies can be to other modules in same kit OR cross-kit (contains ':')
    if (depName.includes(':')) {
      // Cross-kit: {kit}:{module} — just validate format
      const parts = depName.split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        fail(`Module "${name}" has invalid cross-kit dep format: "${depName}" (expected {kit}:{module})`);
      } else {
        pass(`Cross-kit dep "${depName}" has valid format`);
      }
    } else {
      // Same-kit dependency
      if (!modules[depName]) {
        fail(`Module "${name}" depends on "${depName}" which is not declared in modules`);
      } else {
        pass(`Dep "${name}" → "${depName}" resolves`);
      }
    }
  }
}

// ── Check 8: No circular dependencies (DAG validation) ──────────────────────
console.log('\n[validate] Checking for circular dependencies...');

function detectCycles(modName, visited, stack) {
  visited.add(modName);
  stack.add(modName);

  const mod = modules[modName];
  if (!mod || !mod.dependencies) {
    stack.delete(modName);
    return false;
  }

  for (const depName of Object.keys(mod.dependencies)) {
    // Skip cross-kit deps for cycle detection
    if (depName.includes(':')) continue;
    if (!modules[depName]) continue;

    if (!visited.has(depName)) {
      if (detectCycles(depName, visited, stack)) return true;
    } else if (stack.has(depName)) {
      fail(`Circular dependency detected: ${[...stack, depName].join(' → ')}`);
      return true;
    }
  }

  stack.delete(modName);
  return false;
}

const visited = new Set();
let hasCycle = false;
for (const modName of moduleNames) {
  if (!visited.has(modName)) {
    if (detectCycles(modName, visited, new Set())) {
      hasCycle = true;
    }
  }
}

if (!hasCycle) {
  pass('No circular dependencies found');
}

// ── Check 9: Priority collision detection ────────────────────────────────────
console.log('\n[validate] Checking priority collisions...');

// Compute depth-based priority per module (91 + depth)
// depth = longest dependency chain length
function computeDepth(modName, memo = {}) {
  if (memo[modName] !== undefined) return memo[modName];
  const mod = modules[modName];
  if (!mod || !mod.dependencies || Object.keys(mod.dependencies).length === 0) {
    memo[modName] = 0;
    return 0;
  }
  let maxDep = 0;
  for (const depName of Object.keys(mod.dependencies)) {
    if (depName.includes(':')) continue; // skip cross-kit
    if (!modules[depName]) continue;
    maxDep = Math.max(maxDep, computeDepth(depName, memo) + 1);
  }
  memo[modName] = maxDep;
  return maxDep;
}

const depths = {};
for (const modName of moduleNames) {
  depths[modName] = computeDepth(modName);
}

// Check routing overlays for role collisions at same priority
const priorityRoleMap = {}; // `${priority}:${role}` -> module

for (const [name, mod] of Object.entries(modules)) {
  if (!mod.routingOverlay) continue;
  const overlayPath = path.join(ROOT, '.claude', mod.routingOverlay);
  if (!fs.existsSync(overlayPath)) continue;

  let overlay;
  try {
    overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  } catch {
    warn(`Could not parse routing overlay for module "${name}" — skipping priority check`);
    continue;
  }

  const computedPriority = 91 + depths[name];
  const roles = overlay.roles || {};

  for (const role of Object.keys(roles)) {
    const key = `${computedPriority}:${role}`;
    if (priorityRoleMap[key]) {
      fail(`Priority collision: role "${role}" at priority ${computedPriority} in both "${priorityRoleMap[key]}" and "${name}"`);
    } else {
      priorityRoleMap[key] = name;
    }
  }
}

const collisionChecked = Object.keys(modules).filter((m) => modules[m].routingOverlay).length;
if (collisionChecked > 0) {
  pass(`Priority collision check passed across ${collisionChecked} routing overlay(s)`);
} else {
  pass('No routing overlays to check for priority collisions');
}

// ── Check 10: Preset references resolve ─────────────────────────────────────
console.log('\n[validate] Checking preset references...');

const presets = registry.presets || {};
for (const [presetName, preset] of Object.entries(presets)) {
  const presetModules = preset.modules || [];
  for (const ref of presetModules) {
    if (ref.includes(':')) {
      // Cross-kit ref: {kit}:{module}
      const parts = ref.split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        fail(`Preset "${presetName}" has invalid cross-kit ref: "${ref}" (expected {kit}:{module})`);
      } else {
        pass(`Preset "${presetName}": cross-kit ref "${ref}" has valid syntax`);
      }
    } else {
      // Same-kit module ref
      if (!modules[ref]) {
        fail(`Preset "${presetName}" references unknown module "${ref}"`);
      } else {
        pass(`Preset "${presetName}": module "${ref}" resolves`);
      }
    }
  }
}

const presetCount = Object.keys(presets).length;
if (presetCount === 0) {
  pass('No presets to validate');
}

// ── Check 11: Kit-wide files NOT inside module directories ───────────────────
console.log('\n[validate] Checking kit-wide file placement...');

const kitWideFiles = [
  '.claude/t1k-routing-core.json',
  '.claude/t1k-activation-core.json',
  '.claude/t1k-config-core.json',
  '.claude/metadata.json',
];

// Module-owned paths (from skills/agents directories per module)
const modulePaths = new Set();
for (const [, mod] of Object.entries(modules)) {
  if (mod.activationFragment) modulePaths.add(`.claude/${mod.activationFragment}`);
  if (mod.routingOverlay) modulePaths.add(`.claude/${mod.routingOverlay}`);
  if (mod.skills) mod.skills.forEach((s) => modulePaths.add(`.claude/skills/${s}`));
  if (mod.agents) mod.agents.forEach((a) => modulePaths.add(`.claude/agents/${a}`));
}

for (const kitFile of kitWideFiles) {
  if (modulePaths.has(kitFile)) {
    fail(`Kit-wide file "${kitFile}" is also declared inside a module — SSOT violation`);
  } else {
    if (fs.existsSync(path.join(ROOT, kitFile))) {
      pass(`Kit-wide file "${kitFile}" is not module-owned`);
    }
    // Non-existent kit-wide files are fine (not all kits have all fragments)
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
if (errors > 0) {
  console.error(`\n[validate] FAILED — ${errors} error(s) found. Release blocked.\n`);
  process.exit(1);
} else {
  console.log(`\n[validate] PASSED — all ${moduleNames.length} module(s) valid.\n`);
  process.exit(0);
}
