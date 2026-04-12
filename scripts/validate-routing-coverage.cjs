#!/usr/bin/env node
'use strict';
// validate-routing-coverage.cjs — CI quality gate
// Warns when agents exist in .claude/agents/ but have no role mapping
// in any t1k-routing-*.json fragment.

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const claudeDir = path.join(kitRoot, '.claude');

if (!fs.existsSync(claudeDir)) {
    console.log('No .claude/ directory found — skipping');
    process.exit(0);
}

// Collect all agent names from .md files
const agentsDir = path.join(claudeDir, 'agents');
const agentNames = [];
if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
        if (f.endsWith('.md')) {
            agentNames.push(f.replace('.md', ''));
        }
    }
}

if (agentNames.length === 0) {
    console.log('No agents found — skipping routing coverage check');
    process.exit(0);
}

// Collect all agent names referenced in routing fragments
const routedAgents = new Set();
const routingFiles = fs.readdirSync(claudeDir)
    .filter(f => f.startsWith('t1k-routing-') && f.endsWith('.json'));

for (const rf of routingFiles) {
    try {
        const frag = JSON.parse(fs.readFileSync(path.join(claudeDir, rf), 'utf8'));
        for (const agentName of Object.values(frag.roles || {})) {
            routedAgents.add(agentName);
        }
    } catch {}
}

// Check coverage
const uncovered = agentNames.filter(a => !routedAgents.has(a));
if (uncovered.length > 0) {
    console.log(`\nRouting coverage: ${agentNames.length - uncovered.length}/${agentNames.length} agents registered`);
    for (const a of uncovered) {
        console.log(`::warning file=.claude/agents/${a}.md::Agent "${a}" has no role mapping in any t1k-routing-*.json fragment`);
    }
} else {
    console.log(`Routing coverage: ${agentNames.length}/${agentNames.length} agents registered`);
}

process.exit(0);
