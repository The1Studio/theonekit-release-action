#!/usr/bin/env node
'use strict';
// t1k-origin: kit=theonekit-release-action | repo=The1Studio/theonekit-release-action | module=null | protected=true
// validate-generated-file-integrity.cjs — CI quality gate (warning-only)
//
// Detects when auto-generated files are manually edited in PRs.
//
// Detection method:
//   1. Get changed files: git diff --name-only origin/main...HEAD -- .claude/
//      Fallback: HEAD~1...HEAD if origin/main is unavailable
//   2. For each changed JSON file in .claude/: check for _generated, _generatedBy,
//      _generatedFrom, or generatedBy fields
//   3. For each changed .md file: check first 5 lines for # AUTO-GENERATED marker
//   4. If a generated file is found in the diff → emit ::warning with source pointer
//
// Edge cases handled:
//   - git diff failure (no origin/main, detached HEAD): skip gracefully
//   - Only _origin fields changed: skip (CI-only change, not manual edit)
//
// This gate is ALWAYS warning-only — exit 0 regardless of findings.
// It is informational only and never blocks CI.
//
// Usage:
//   node scripts/validate-generated-file-integrity.cjs [kit-root]
//   (defaults to cwd if no argument given)
//
// Exit: Always 0

const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(str) {
  return String(str)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function emitWarning(relFile, message) {
  console.log(`::warning file=${sanitize(relFile)}::${sanitize(message)}`);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(filePath) {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Git diff ──────────────────────────────────────────────────────────────────

/**
 * Get list of changed files in .claude/ for the current PR.
 * Tries origin/main...HEAD first, falls back to HEAD~1...HEAD.
 * Returns null if git is unavailable or diff cannot be computed.
 */
function getChangedClaudeFiles(kitRoot) {
  const gitArgs = ['diff', '--name-only'];

  // Try primary ref: origin/main...HEAD
  try {
    const output = execFileSync('git', [...gitArgs, 'origin/main...HEAD', '--', '.claude/'], {
      cwd: kitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    // Primary ref unavailable — try fallback
  }

  // Try fallback: HEAD~1...HEAD
  try {
    const output = execFileSync('git', [...gitArgs, 'HEAD~1...HEAD', '--', '.claude/'], {
      cwd: kitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    // Git unavailable or detached HEAD with no commits — skip gracefully
    return null;
  }
}

// ── Generation marker detection ───────────────────────────────────────────────

/**
 * Check if a JSON file contains generated-file markers.
 * Returns { isGenerated, sourcePointer } or null.
 */
function checkJsonGenerated(data) {
  if (!data || typeof data !== 'object') return null;

  // Check for generation markers
  const hasGenerated      = '_generated'    in data;
  const hasGeneratedBy    = '_generatedBy'  in data || 'generatedBy' in data;
  const hasGeneratedFrom  = '_generatedFrom' in data;

  if (!hasGenerated && !hasGeneratedBy && !hasGeneratedFrom) return null;

  const source = data._generatedFrom || data._generatedBy || data.generatedBy || null;
  return { isGenerated: true, sourcePointer: source };
}

/**
 * Check if a Markdown file has an AUTO-GENERATED header in its first 5 lines.
 * Returns { isGenerated, sourcePointer } or null.
 */
function checkMarkdownGenerated(content) {
  if (!content) return null;
  const lines = content.split('\n').slice(0, 5);
  for (const line of lines) {
    if (/^#\s+AUTO-GENERATED/i.test(line.trim())) {
      // Try to extract a source hint from the same line or the next few lines
      const sourceMatch = content.match(/generated\s+from[:\s]+([^\n]+)/i);
      return { isGenerated: true, sourcePointer: sourceMatch ? sourceMatch[1].trim() : null };
    }
  }
  return null;
}

/**
 * Check if the diff for a JSON file ONLY changes _origin fields.
 * This is a best-effort heuristic: if the file content only differs in _origin,
 * it was a CI-managed change, not a manual edit.
 * Since we only have the final file content (not the diff), we check whether
 * the file contains non-_origin generated markers AND has non-trivial changes.
 */
function isOriginOnlyChange(data) {
  if (!data || typeof data !== 'object') return false;

  // If the only top-level keys are _origin and the standard schema keys, it's likely CI-managed
  const keys       = Object.keys(data);
  const originKeys = new Set(['_origin', 'registryVersion', 'kitName', 'priority', 'roles',
                               'mappings', 'sessionBaseline', 'description', 'modules',
                               'context', 'features', 'mcp', 'repos', 'cli', 'telemetry',
                               'autoIssueSubmission', 'extraCommands', 'errorRecovery',
                               '_modulesGeneratedFrom']);
  return keys.every(k => originKeys.has(k));
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const kitRoot = path.resolve(process.argv[2] || process.cwd());

  if (!fs.existsSync(path.join(kitRoot, '.claude'))) {
    console.log('[generated-integrity] No .claude/ directory found — skipping');
    process.exit(0);
  }

  const changedFiles = getChangedClaudeFiles(kitRoot);
  if (changedFiles === null) {
    console.log('[generated-integrity] Could not determine changed files (no git history or detached HEAD) — skipping');
    process.exit(0);
  }

  if (changedFiles.length === 0) {
    console.log('[generated-integrity] No .claude/ files changed — skipping');
    process.exit(0);
  }

  console.log(`[generated-integrity] Checking ${changedFiles.length} changed .claude/ file(s)`);

  let warnings = 0;

  for (const relFilePath of changedFiles) {
    const absPath = path.join(kitRoot, relFilePath);
    const ext     = path.extname(relFilePath).toLowerCase();

    if (ext === '.json') {
      const data = readJsonSafe(absPath);
      if (!data) continue;

      // Skip if only _origin and standard registry keys changed
      if (isOriginOnlyChange(data)) continue;

      const result = checkJsonGenerated(data);
      if (!result) continue;

      const sourceHint = result.sourcePointer
        ? ` — source: ${result.sourcePointer}`
        : ' — check the generator script for this file';

      emitWarning(
        relFilePath,
        `Auto-generated file modified in PR${sourceHint}. ` +
        'If this is intentional, edit the generator instead of the generated file.'
      );
      warnings++;

    } else if (ext === '.md') {
      const content = readFileSafe(absPath);
      if (!content) continue;

      const result = checkMarkdownGenerated(content);
      if (!result) continue;

      const sourceHint = result.sourcePointer
        ? ` — source: ${result.sourcePointer}`
        : ' — check the generator script for this file';

      emitWarning(
        relFilePath,
        `Auto-generated file modified in PR${sourceHint}. ` +
        'If this is intentional, edit the generator instead of the generated file.'
      );
      warnings++;
    }
  }

  console.log(`[generated-integrity] warnings=${warnings} (gate is informational only)`);

  // Always exit 0 — this gate never blocks CI
  process.exit(0);
}

main();
