#!/usr/bin/env node
'use strict';
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
// validate-registry-schema.cjs — CI quality gate
//
// Validates JSON structure of all T1K registry fragments found in .claude/:
//
//   t1k-routing-*.json    — { registryVersion: number, priority: number, roles: { [role]: string } }
//   t1k-activation-*.json — { registryVersion: number, kitName: string, priority: number,
//                              mappings: [{ keywords: string[], skills: string[] }] }
//   t1k-config-*.json     — { kitName: string }  (additional properties allowed)
//   t1k-modules.json      — { registryVersion: 2, kitName: string, modules: object }
//
// Validation is permissive — only required structural fields are checked.
// Additional properties (extraCommands, cli, telemetry, etc.) are always allowed.
//
// Usage:
//   node scripts/validate-registry-schema.cjs [kit-root]
//   (defaults to cwd if no argument given)
//
// Exit 0 = valid (or warnings only)
// Exit 1 = schema violation found
//
// Environment:
//   T1K_GATE_WARN_ONLY=1  -- demote all errors to warnings (rollback mode)

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const WARN_ONLY = process.env.T1K_GATE_WARN_ONLY === '1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { error: `Cannot read file: ${err.message}`, data: null };
  }
  try {
    return { error: null, data: JSON.parse(raw) };
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}`, data: null };
  }
}

function sanitize(str) {
  return String(str)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function emitError(relFile, message) {
  const level = WARN_ONLY ? 'warning' : 'error';
  console.log(`::${level} file=${sanitize(relFile)}::${sanitize(message)}`);
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function isNumber(v)        { return typeof v === 'number' && isFinite(v); }
function isString(v)        { return typeof v === 'string' && v.trim().length > 0; }
function isPlainObject(v)   { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isArray(v)         { return Array.isArray(v); }

// ── Schema validators ─────────────────────────────────────────────────────────

/**
 * Validate t1k-routing-*.json:
 *   Required: registryVersion (number), priority (number), roles (object with string values)
 */
function validateRoutingFragment(data, relFile) {
  let errors = 0;

  if (!isNumber(data.registryVersion)) {
    emitError(relFile, `t1k-routing: "registryVersion" must be a number (got ${JSON.stringify(data.registryVersion)})`);
    errors++;
  }

  if (!isNumber(data.priority)) {
    emitError(relFile, `t1k-routing: "priority" must be a number (got ${JSON.stringify(data.priority)})`);
    errors++;
  }

  if (!isPlainObject(data.roles)) {
    emitError(relFile, `t1k-routing: "roles" must be an object (got ${typeof data.roles})`);
    errors++;
  } else {
    for (const [role, agent] of Object.entries(data.roles)) {
      if (typeof agent !== 'string' || agent.trim().length === 0) {
        emitError(relFile, `t1k-routing: roles["${role}"] must be a non-empty string (got ${JSON.stringify(agent)})`);
        errors++;
      }
    }
  }

  return errors;
}

/**
 * Validate t1k-activation-*.json:
 *   Required: registryVersion (number), kitName (string), priority (number)
 *   Optional: mappings (array of { keywords: string[], skills: string[] })
 *             sessionBaseline-only fragments are valid and have no mappings field.
 */
function validateActivationFragment(data, relFile) {
  let errors = 0;

  if (!isNumber(data.registryVersion)) {
    emitError(relFile, `t1k-activation: "registryVersion" must be a number (got ${JSON.stringify(data.registryVersion)})`);
    errors++;
  }

  if (!isString(data.kitName)) {
    emitError(relFile, `t1k-activation: "kitName" must be a non-empty string (got ${JSON.stringify(data.kitName)})`);
    errors++;
  }

  if (!isNumber(data.priority)) {
    emitError(relFile, `t1k-activation: "priority" must be a number (got ${JSON.stringify(data.priority)})`);
    errors++;
  }

  // mappings is optional — sessionBaseline-only fragments may omit it entirely
  if (data.mappings !== undefined && !isArray(data.mappings)) {
    emitError(relFile, `t1k-activation: "mappings" must be an array when present (got ${typeof data.mappings})`);
    errors++;
  } else if (isArray(data.mappings)) {
    data.mappings.forEach((mapping, idx) => {
      if (!isPlainObject(mapping)) {
        emitError(relFile, `t1k-activation: mappings[${idx}] must be an object`);
        errors++;
        return;
      }
      if (!isArray(mapping.keywords)) {
        emitError(relFile, `t1k-activation: mappings[${idx}].keywords must be an array`);
        errors++;
      } else {
        mapping.keywords.forEach((kw, ki) => {
          if (typeof kw !== 'string' || kw.trim().length === 0) {
            emitError(relFile, `t1k-activation: mappings[${idx}].keywords[${ki}] must be a non-empty string (got ${JSON.stringify(kw)})`);
            errors++;
          }
        });
      }
      if (!isArray(mapping.skills)) {
        emitError(relFile, `t1k-activation: mappings[${idx}].skills must be an array`);
        errors++;
      } else {
        mapping.skills.forEach((sk, si) => {
          if (typeof sk !== 'string' || sk.trim().length === 0) {
            emitError(relFile, `t1k-activation: mappings[${idx}].skills[${si}] must be a non-empty string (got ${JSON.stringify(sk)})`);
            errors++;
          }
        });
      }
    });
  }

  return errors;
}

/**
 * Validate t1k-config-*.json:
 *   Required: kitName (string)
 *   All other fields are allowed (kits add custom extensions).
 */
function validateConfigFragment(data, relFile) {
  let errors = 0;

  if (!isString(data.kitName)) {
    emitError(relFile, `t1k-config: "kitName" must be a non-empty string (got ${JSON.stringify(data.kitName)})`);
    errors++;
  }

  return errors;
}

/**
 * Validate t1k-modules.json:
 *   Required: registryVersion (must be 2), kitName (string), modules (object)
 */
function validateModulesRegistry(data, relFile) {
  let errors = 0;

  if (!isNumber(data.registryVersion)) {
    emitError(relFile, `t1k-modules: "registryVersion" must be a number (got ${JSON.stringify(data.registryVersion)})`);
    errors++;
  } else if (data.registryVersion !== 2) {
    emitError(relFile, `t1k-modules: "registryVersion" must be 2 (got ${data.registryVersion})`);
    errors++;
  }

  if (!isString(data.kitName)) {
    emitError(relFile, `t1k-modules: "kitName" must be a non-empty string (got ${JSON.stringify(data.kitName)})`);
    errors++;
  }

  if (!isPlainObject(data.modules)) {
    emitError(relFile, `t1k-modules: "modules" must be an object (got ${typeof data.modules})`);
    errors++;
  }

  return errors;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const kitRoot   = path.resolve(process.argv[2] || process.cwd());
  const claudeDir = path.join(kitRoot, '.claude');

  if (!fs.existsSync(claudeDir)) {
    console.log('[registry-schema] No .claude/ directory found — skipping');
    process.exit(0);
  }

  if (WARN_ONLY) {
    console.log('[registry-schema] WARN_ONLY mode active — errors will be emitted as warnings');
  }

  let totalErrors  = 0;
  let filesChecked = 0;

  let claudeEntries;
  try {
    claudeEntries = fs.readdirSync(claudeDir);
  } catch (err) {
    console.error(`[registry-schema] Cannot read .claude/ directory: ${err.message}`);
    process.exit(1);
  }

  for (const entry of claudeEntries) {
    if (!entry.endsWith('.json')) continue;

    const filePath = path.join(claudeDir, entry);
    const relFile  = path.join('.claude', entry);

    // Skip non-T1K registry fragments and _origin-only files
    const isRouting    = /^t1k-routing-.+\.json$/.test(entry);
    const isActivation = /^t1k-activation-.+\.json$/.test(entry);
    const isConfig     = /^t1k-config-.+\.json$/.test(entry);
    const isModules    = entry === 't1k-modules.json';

    if (!isRouting && !isActivation && !isConfig && !isModules) continue;

    const { error, data } = readJsonSafe(filePath);
    if (error) {
      emitError(relFile, `Cannot parse registry fragment: ${error}`);
      totalErrors++;
      filesChecked++;
      continue;
    }

    if (!isPlainObject(data)) {
      emitError(relFile, 'Registry fragment must be a JSON object at the top level');
      totalErrors++;
      filesChecked++;
      continue;
    }

    let fileErrors = 0;
    if (isRouting)    fileErrors = validateRoutingFragment(data, relFile);
    if (isActivation) fileErrors = validateActivationFragment(data, relFile);
    if (isConfig)     fileErrors = validateConfigFragment(data, relFile);
    if (isModules)    fileErrors = validateModulesRegistry(data, relFile);

    totalErrors += fileErrors;
    filesChecked++;
  }

  console.log(`[registry-schema] files=${filesChecked} errors=${totalErrors}`);

  if (totalErrors > 0 && !WARN_ONLY) {
    console.error(`[registry-schema] Validation failed with ${totalErrors} error(s)`);
    process.exit(1);
  }

  process.exit(0);
}

main();
