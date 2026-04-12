#!/usr/bin/env node
'use strict';
// validate-cross-platform.cjs — CI quality gate
// Scans .claude/hooks/*.cjs for platform-specific patterns.
// See CLAUDE.md "Cross-Platform Requirement" for the full rules.

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const hooksDir = path.join(kitRoot, '.claude', 'hooks');

if (!fs.existsSync(hooksDir)) {
    console.log('No .claude/hooks/ directory found — skipping');
    process.exit(0);
}

const PATTERNS = [
    { regex: /\/dev\/stdin/g, msg: 'Use fs.readFileSync(0, "utf8") instead of /dev/stdin' },
    { regex: /2>\/dev\/null/g, msg: 'Use stdio: ["pipe", "pipe", "ignore"] instead of 2>/dev/null' },
    { regex: /[`'"]\/tmp\//g, msg: 'Use os.tmpdir() instead of hardcoded /tmp/' },
    { regex: /[`'"]\/home\//g, msg: 'Use os.homedir() instead of hardcoded /home/' },
];

const errors = [];
const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.cjs'));

for (const file of hookFiles) {
    const filePath = path.join(hooksDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        for (const { regex, msg } of PATTERNS) {
            regex.lastIndex = 0;
            if (regex.test(line)) {
                errors.push({ file: `.claude/hooks/${file}`, line: lineNum + 1, msg });
            }
        }
    }
}

if (errors.length > 0) {
    for (const { file, line, msg } of errors) {
        console.log(`::error file=${file},line=${line}::Cross-platform: ${msg}`);
    }
    console.error(`\nCross-platform validation failed with ${errors.length} error(s)`);
    process.exit(1);
} else {
    console.log(`Cross-platform validation passed (${hookFiles.length} hook files checked)`);
}
