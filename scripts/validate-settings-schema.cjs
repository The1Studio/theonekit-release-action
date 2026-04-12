#!/usr/bin/env node
'use strict';
// validate-settings-schema.cjs — CI quality gate
// Validates .claude/settings.json against Claude Code's required hook schema.
// Prevents "hooks: Expected array, but received undefined" errors that
// disable ALL hooks for consumers.

const fs = require('fs');
const path = require('path');

const kitRoot = process.argv[2] || '.';
const settingsPath = path.join(kitRoot, '.claude', 'settings.json');

if (!fs.existsSync(settingsPath)) {
    console.log('No .claude/settings.json found — skipping validation');
    process.exit(0);
}

let settings;
try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (err) {
    console.log(`::error file=.claude/settings.json::Invalid JSON: ${err.message}`);
    process.exit(1);
}

const errors = [];

if (settings.hooks) {
    for (const [event, entries] of Object.entries(settings.hooks)) {
        if (!Array.isArray(entries)) {
            errors.push(`${event}: Expected array, got ${typeof entries}`);
            continue;
        }
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || typeof entry !== 'object') {
                errors.push(`${event}[${i}]: Expected object, got ${typeof entry}`);
                continue;
            }
            // Grouped format: hooks must be array
            if ('hooks' in entry) {
                if (!Array.isArray(entry.hooks)) {
                    errors.push(`${event}[${i}].hooks: Expected array, got ${typeof entry.hooks}`);
                } else {
                    for (let j = 0; j < entry.hooks.length; j++) {
                        const hook = entry.hooks[j];
                        if (!hook || typeof hook !== 'object') {
                            errors.push(`${event}[${i}].hooks[${j}]: Expected object`);
                        } else if (!hook.type || !hook.command) {
                            errors.push(`${event}[${i}].hooks[${j}]: Missing type or command`);
                        }
                    }
                }
            }
            // Flat format: if has command, must have type
            if ('command' in entry && !('hooks' in entry)) {
                if (!entry.type || !entry.command) {
                    errors.push(`${event}[${i}]: Flat hook entry missing type or command`);
                }
            }
        }
    }
}

if (errors.length > 0) {
    for (const err of errors) {
        console.log(`::error file=.claude/settings.json::${err}`);
    }
    console.error(`\nSettings schema validation failed with ${errors.length} error(s)`);
    process.exit(1);
}

console.log('Settings schema validation passed');
