#!/usr/bin/env node
'use strict';
// generate-routing-from-agents.cjs — Release pipeline step
// Scans agent .md files for `roles:` in YAML frontmatter.
// For each role that has NO mapping in ANY t1k-routing-*.json fragment,
// adds the role → agent mapping to the lowest-priority routing fragment.
// If no fragment exists, creates t1k-routing-auto.json (priority 5).
//
// NEVER overrides existing role mappings — only fills unmapped roles.
// If `roles: none` in frontmatter, the agent is skipped (utility/helper agent).
//
// Usage: node scripts/generate-routing-from-agents.cjs <kit-root-path>

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const claudeDir = path.join(kitRoot, '.claude');

if (!fs.existsSync(claudeDir)) {
    console.log('[generate-routing] No .claude/ directory — skipping');
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
 * Collect all agent .md file paths from .claude/agents/
 */
function collectAgentFiles(claudeDir) {
    const agentsDir = path.join(claudeDir, 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(agentsDir, f));
}

/**
 * Load all t1k-routing-*.json fragments from claudeDir.
 * Returns array of { filePath, fragment } sorted by priority ascending
 * (lowest priority first, so we add to the lowest-priority one).
 */
function loadRoutingFragments(claudeDir) {
    const fragments = [];
    for (const f of fs.readdirSync(claudeDir)) {
        if (!f.startsWith('t1k-routing-') || !f.endsWith('.json')) continue;
        const filePath = path.join(claudeDir, f);
        try {
            const fragment = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            fragments.push({ filePath, fragment });
        } catch (e) {
            console.warn(`[generate-routing] Could not parse ${f}: ${e.message}`);
        }
    }
    // Sort by priority ascending — lowest first (we add to the lowest-priority fragment)
    fragments.sort((a, b) => (a.fragment.priority || 0) - (b.fragment.priority || 0));
    return fragments;
}

/**
 * Build a Set of all roles that already appear in ANY routing fragment's `roles` map.
 */
function buildMappedRolesSet(fragments) {
    const mappedRoles = new Set();
    for (const { fragment } of fragments) {
        for (const role of Object.keys(fragment.roles || {})) {
            mappedRoles.add(role);
        }
    }
    return mappedRoles;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const agentFiles = collectAgentFiles(claudeDir);
if (agentFiles.length === 0) {
    console.log('[generate-routing] No agent .md files found — skipping');
    process.exit(0);
}

// Parse agents: collect those with `roles:` in frontmatter (excluding "none")
const agentsWithRoles = [];
for (const agentFilePath of agentFiles) {
    try {
        const content = fs.readFileSync(agentFilePath, 'utf8');
        const fm = parseFrontmatter(content);
        if (!fm.name) continue;
        if (!fm.roles) continue;

        const rolesRaw = Array.isArray(fm.roles) ? fm.roles : [fm.roles];
        // Skip utility agents that explicitly declare `roles: none`
        if (rolesRaw.length === 1 && rolesRaw[0].toLowerCase() === 'none') continue;
        if (rolesRaw.length === 0) continue;

        agentsWithRoles.push({
            name: fm.name,       // e.g. "fullstack-developer"
            roles: rolesRaw,     // e.g. ["implementer"]
            filePath: agentFilePath,
        });
    } catch (e) {
        console.warn(`[generate-routing] Could not parse ${agentFilePath}: ${e.message}`);
    }
}

if (agentsWithRoles.length === 0) {
    console.log('[generate-routing] No agents with `roles:` frontmatter found — nothing to generate');
    process.exit(0);
}

// Load existing routing fragments
let fragments = loadRoutingFragments(claudeDir);
const mappedRoles = buildMappedRolesSet(fragments);

// Determine which roles need new mappings: role not in any fragment
const rolesToAdd = []; // { role, agentName }
for (const agent of agentsWithRoles) {
    for (const role of agent.roles) {
        if (!mappedRoles.has(role)) {
            rolesToAdd.push({ role, agentName: agent.name });
        }
    }
}

if (rolesToAdd.length === 0) {
    console.log(`[generate-routing] All roles from agents with \`roles:\` frontmatter are already mapped — no changes needed`);
    process.exit(0);
}

// Determine the target fragment: lowest-priority existing one, or create auto fragment
let targetEntry;
if (fragments.length > 0) {
    targetEntry = fragments[0];
} else {
    // Create a new auto fragment
    const autoPath = path.join(claudeDir, 't1k-routing-auto.json');
    const autoFragment = {
        registryVersion: 1,
        priority: 5,
        description: 'Auto-generated routing mappings from agent .md frontmatter roles.',
        roles: {},
    };
    targetEntry = { filePath: autoPath, fragment: autoFragment };
    fragments.push(targetEntry);
}

// Add new role mappings to the target fragment
if (!targetEntry.fragment.roles) {
    targetEntry.fragment.roles = {};
}

let addedCount = 0;
for (const { role, agentName } of rolesToAdd) {
    // Double-check: another entry in the fragment already maps this role
    // (could happen if two agents claim the same unmapped role)
    if (targetEntry.fragment.roles[role]) {
        console.log(`[generate-routing] Role "${role}" collision — already set to "${targetEntry.fragment.roles[role]}", skipping "${agentName}"`);
        continue;
    }
    targetEntry.fragment.roles[role] = agentName;
    addedCount++;
    console.log(`[generate-routing] Added role mapping: "${role}" → "${agentName}"`);
}

if (addedCount === 0) {
    console.log('[generate-routing] No new mappings added (all resolved during collision detection)');
    process.exit(0);
}

// Write back the modified fragment (pretty-printed, 2-space indent)
fs.writeFileSync(
    targetEntry.filePath,
    JSON.stringify(targetEntry.fragment, null, 2) + '\n',
    'utf8'
);

console.log(`[generate-routing] Done — ${addedCount} new role mapping(s) added to ${path.basename(targetEntry.filePath)}`);
process.exit(0);
