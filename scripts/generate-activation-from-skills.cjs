#!/usr/bin/env node
'use strict';
// generate-activation-from-skills.cjs — Release pipeline step
// Scans SKILL.md files for `keywords:` in YAML frontmatter.
// For each skill with keywords that has NO existing mapping in any
// t1k-activation-*.json fragment, adds a new mapping entry to the
// lowest-priority fragment (core = p10). If no fragment exists,
// creates t1k-activation-auto.json (priority 5).
//
// NEVER removes or overrides existing mappings — only fills gaps.
//
// Usage: node scripts/generate-activation-from-skills.cjs <kit-root-path>

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const claudeDir = path.join(kitRoot, '.claude');

if (!fs.existsSync(claudeDir)) {
    console.log('[generate-activation] No .claude/ directory — skipping');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a Markdown file.
 * Supports:
 *   - Simple scalars:  key: value
 *   - Inline arrays:   key: [a, b, c]
 *   - Comma-separated: key: a, b, c
 * Returns an object with string keys and string|string[] values.
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const result = {};
    for (const line of match[1].split('\n')) {
        const m = line.match(/^([\w][\w-]*):\s*(.+)/);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        // Inline YAML array: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
            value = value
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        } else if (value.includes(',')) {
            // Comma-separated values without brackets
            value = value
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        }
        result[key] = value;
    }
    return result;
}

/**
 * Collect all SKILL.md paths from:
 *   .claude/skills/<name>/SKILL.md
 *   .claude/modules/<mod>/skills/<name>/SKILL.md
 */
function collectSkillFiles(claudeDir) {
    const results = [];
    const skillsRoot = path.join(claudeDir, 'skills');
    if (fs.existsSync(skillsRoot)) {
        for (const d of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const skillMd = path.join(skillsRoot, d.name, 'SKILL.md');
            if (fs.existsSync(skillMd)) results.push(skillMd);
        }
    }
    const modulesRoot = path.join(claudeDir, 'modules');
    if (fs.existsSync(modulesRoot)) {
        for (const mod of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
            if (!mod.isDirectory()) continue;
            const modSkillsRoot = path.join(modulesRoot, mod.name, 'skills');
            if (!fs.existsSync(modSkillsRoot)) continue;
            for (const d of fs.readdirSync(modSkillsRoot, { withFileTypes: true })) {
                if (!d.isDirectory()) continue;
                const skillMd = path.join(modSkillsRoot, d.name, 'SKILL.md');
                if (fs.existsSync(skillMd)) results.push(skillMd);
            }
        }
    }
    return results;
}

/**
 * Load all t1k-activation-*.json fragments from claudeDir.
 * Returns array of { filePath, fragment } sorted by priority ascending
 * (lowest priority first, so we add to the lowest-priority one).
 */
function loadActivationFragments(claudeDir) {
    const fragments = [];
    for (const f of fs.readdirSync(claudeDir)) {
        if (!f.startsWith('t1k-activation-') || !f.endsWith('.json')) continue;
        const filePath = path.join(claudeDir, f);
        try {
            const fragment = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            fragments.push({ filePath, fragment });
        } catch (e) {
            console.warn(`[generate-activation] Could not parse ${f}: ${e.message}`);
        }
    }
    // Sort by priority ascending — lowest first (we add to the lowest-priority fragment)
    fragments.sort((a, b) => (a.fragment.priority || 0) - (b.fragment.priority || 0));
    return fragments;
}

/**
 * Build a Set of all skill names that already appear in ANY activation mapping.
 * Checks both sessionBaseline and mappings[].skills.
 */
function buildActivatedSkillsSet(fragments) {
    const activated = new Set();
    for (const { fragment } of fragments) {
        for (const s of (fragment.sessionBaseline || [])) {
            activated.add(s);
        }
        for (const mapping of (fragment.mappings || [])) {
            for (const s of (mapping.skills || [])) {
                activated.add(s);
            }
        }
    }
    return activated;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const skillFiles = collectSkillFiles(claudeDir);
if (skillFiles.length === 0) {
    console.log('[generate-activation] No SKILL.md files found — skipping');
    process.exit(0);
}

// Parse skills: collect those with `keywords:` in frontmatter
const skillsWithKeywords = [];
for (const skillMdPath of skillFiles) {
    try {
        const content = fs.readFileSync(skillMdPath, 'utf8');
        const fm = parseFrontmatter(content);
        if (!fm.name) continue;
        if (!fm.keywords) continue;
        const keywords = Array.isArray(fm.keywords) ? fm.keywords : [fm.keywords];
        if (keywords.length === 0) continue;
        // Derive the skill directory name (used as the skill activation key)
        // The directory name is the parent folder of SKILL.md
        const skillDirName = path.basename(path.dirname(skillMdPath));
        skillsWithKeywords.push({
            name: fm.name,          // e.g. "t1k:graphify"
            dirName: skillDirName,  // e.g. "t1k-graphify"
            keywords,
        });
    } catch (e) {
        console.warn(`[generate-activation] Could not parse ${skillMdPath}: ${e.message}`);
    }
}

if (skillsWithKeywords.length === 0) {
    console.log('[generate-activation] No skills with `keywords:` frontmatter found — nothing to generate');
    process.exit(0);
}

// Load existing activation fragments
let fragments = loadActivationFragments(claudeDir);
const activatedSkills = buildActivatedSkillsSet(fragments);

// Determine which skills need new mappings
const skillsToAdd = skillsWithKeywords.filter(s => !activatedSkills.has(s.dirName));

if (skillsToAdd.length === 0) {
    console.log(`[generate-activation] All ${skillsWithKeywords.length} skills with keywords are already mapped — no changes needed`);
    process.exit(0);
}

// Determine the target fragment: lowest-priority existing one, or create auto fragment
let targetEntry;
if (fragments.length > 0) {
    // Use the lowest-priority fragment (first after sorting ascending)
    targetEntry = fragments[0];
} else {
    // Create a new auto fragment
    const autoPath = path.join(claudeDir, 't1k-activation-auto.json');
    const autoFragment = {
        registryVersion: 1,
        kitName: 'auto-generated',
        priority: 5,
        description: 'Auto-generated activation mappings from SKILL.md frontmatter keywords.',
        sessionBaseline: [],
        mappings: [],
    };
    targetEntry = { filePath: autoPath, fragment: autoFragment };
    fragments.push(targetEntry);
}

// Add new mappings to the target fragment
let addedCount = 0;
for (const skill of skillsToAdd) {
    const newMapping = {
        keywords: skill.keywords,
        skills: [skill.dirName],
    };
    targetEntry.fragment.mappings = targetEntry.fragment.mappings || [];
    targetEntry.fragment.mappings.push(newMapping);
    addedCount++;
    console.log(`[generate-activation] Added mapping for "${skill.dirName}" → keywords: [${skill.keywords.join(', ')}]`);
}

// Write back the modified fragment (pretty-printed, 2-space indent)
fs.writeFileSync(
    targetEntry.filePath,
    JSON.stringify(targetEntry.fragment, null, 2) + '\n',
    'utf8'
);

console.log(`[generate-activation] Done — ${addedCount} new mapping(s) added to ${path.basename(targetEntry.filePath)}`);
process.exit(0);
