#!/usr/bin/env node
'use strict';
// validate-activation-coverage.cjs — CI quality gate
// Warns when skills exist in .claude/skills/ but have no keyword mapping
// in any t1k-activation-*.json fragment.

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const claudeDir = path.join(kitRoot, '.claude');

if (!fs.existsSync(claudeDir)) {
    console.log('No .claude/ directory found — skipping');
    process.exit(0);
}

// Collect all skill directory names
const skillDirs = [];
const skillsRoot = path.join(claudeDir, 'skills');
if (fs.existsSync(skillsRoot)) {
    for (const d of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(skillsRoot, d.name, 'SKILL.md'))) {
            skillDirs.push(d.name);
        }
    }
}
// Also check modules/*/skills/*/
const modulesRoot = path.join(claudeDir, 'modules');
if (fs.existsSync(modulesRoot)) {
    for (const mod of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
        if (!mod.isDirectory()) continue;
        const modSkills = path.join(modulesRoot, mod.name, 'skills');
        if (fs.existsSync(modSkills)) {
            for (const d of fs.readdirSync(modSkills, { withFileTypes: true })) {
                if (d.isDirectory() && fs.existsSync(path.join(modSkills, d.name, 'SKILL.md'))) {
                    skillDirs.push(d.name);
                }
            }
        }
    }
}

if (skillDirs.length === 0) {
    console.log('No skills found — skipping activation coverage check');
    process.exit(0);
}

// Collect all skills referenced in activation fragments
const activatedSkills = new Set();
const activationFiles = fs.readdirSync(claudeDir)
    .filter(f => f.startsWith('t1k-activation-') && f.endsWith('.json'));

for (const af of activationFiles) {
    try {
        const frag = JSON.parse(fs.readFileSync(path.join(claudeDir, af), 'utf8'));
        // Session baseline skills
        for (const s of (frag.sessionBaseline || [])) {
            activatedSkills.add(s);
        }
        // Mapped skills
        for (const m of (frag.mappings || [])) {
            for (const s of (m.skills || [])) {
                activatedSkills.add(s);
            }
        }
    } catch {}
}

// Check coverage
const uncovered = skillDirs.filter(s => !activatedSkills.has(s));
if (uncovered.length > 0) {
    console.log(`\nActivation coverage: ${skillDirs.length - uncovered.length}/${skillDirs.length} skills registered`);
    for (const s of uncovered) {
        console.log(`::warning file=.claude/skills/${s}/SKILL.md::Skill "${s}" has no keyword mapping in any t1k-activation-*.json fragment`);
    }
} else {
    console.log(`Activation coverage: ${skillDirs.length}/${skillDirs.length} skills registered`);
}

// Always exit 0 (warning only)
process.exit(0);
