# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**theonekit-release-action** is a reusable GitHub Action (composite action + reusable workflow) for all TheOneKit repos. It handles semantic versioning, ZIP bundling, module validation, and Discord release notifications in a single call.

**Repo:** `The1Studio/theonekit-release-action` (private)

## Architecture

```
theonekit-release-action/
├── action.yml              # Composite action — all steps in one file
├── scripts/                # Node.js CJS scripts (no build step)
│   ├── prepare-release-assets.cjs      # metadata.json + ZIP bundling
│   ├── validate-modules.cjs            # 11-check module manifest validator
│   ├── generate-module-keywords.cjs    # Aggregates activation fragments → keywords map
│   ├── send-discord-release.cjs        # Parses CHANGELOG.md → Discord embed
│   ├── generate-baseline-context.sh    # Hook script injected into modular kits
│   └── check-module-keywords.sh        # Hook script injected into modular kits
└── templates/              # (reserved for future templates)
```

## Key Scripts

### `prepare-release-assets.cjs`
- Reads `KIT_NAME`, `ZIP_NAME`, `ZIP_INCLUDES`, `GITHUB_REPO`, `MODULES_FILE` from env
- Writes `.claude/metadata.json` — version (from `package.json`), repo, module list, cumulative `deletions` array
- Bundles the ZIP from `zip-includes` paths (default: `.claude/`)
- For modular kits: copies `t1k-modules.json` into `.claude/` before zipping

### `validate-modules.cjs`
- Reads modules manifest at `MODULES_FILE` env path
- Runs 11 checks: schema validity, file existence (skills, agents, routing overlays), no skill overlap across modules, no keyword conflicts, valid dependency references, no DAG cycles, priority collision detection, preset resolution, kit-wide file placement
- Exits non-zero on any failure — blocks the release

### `generate-module-keywords.cjs`
- Reads all `t1k-activation-{module}.json` fragments referenced in the modules manifest
- Writes `.claude/t1k-modules-keywords-{kit}.json` — used by `check-module-keywords.sh` hook at runtime to warn users about skills from uninstalled modules

### `send-discord-release.cjs`
- Reads `CHANGELOG.md` to extract the latest release section
- Posts a formatted embed to `DISCORD_WEBHOOK_URL` targeting `DISCORD_THREAD_ID`

### Hook scripts (injected into modular kits at release time)
- `generate-baseline-context.sh` — SessionStart hook: generates baseline context from installed modules
- `check-module-keywords.sh` — UserPromptSubmit hook: warns when prompt keywords match an uninstalled module

## Composite Action Workflow (`action.yml`)

Steps run in order. Module-specific steps are gated on `inputs.modules-validation == 'true'`:

1. **Validate modules** *(modular only)* — `validate-modules.cjs`
2. **Generate module keywords** *(modular only)* — `generate-module-keywords.cjs`
3. **Inject hook scripts** *(modular only)* — copies `generate-baseline-context.sh` and `check-module-keywords.sh` into `.claude/scripts/`
4. **Prepare release assets** — `prepare-release-assets.cjs` (always runs)
5. **Semantic Release** — `npx semantic-release`; sets `new_release=true/false` output
6. **Notify Discord** — `send-discord-release.cjs` (only if `new_release == 'true'`)

## Module Validation Checks

`validate-modules.cjs` enforces these rules on `t1k-modules.json`:

| # | Check |
|---|-------|
| 1 | Schema: `registryVersion: 2`, required fields present |
| 2 | All skill files exist on disk |
| 3 | All agent files exist on disk |
| 4 | All routing overlay files exist on disk |
| 5 | No skill ID appears in more than one module |
| 6 | No keyword appears in multiple module activation fragments |
| 7 | All dependency references resolve to declared modules |
| 8 | No circular dependencies (DAG cycle check) |
| 9 | No routing priority collisions between modules |
| 10 | All preset module lists resolve correctly |
| 11 | Kit-wide files (`t1k-routing-*.json`, etc.) not placed inside module directories |

## Development Guidelines

- **CJS only** — all scripts use `require()`/`module.exports`, no TypeScript, no transpile step
- **No external npm dependencies** — scripts use only Node.js built-ins (`fs`, `path`, `child_process`)
- **Shell scripts** — use POSIX `sh` (not bash-specific syntax) for hook scripts; they run inside consumer kit repos at Claude session time
- **No build step** — scripts run directly via `node scripts/*.cjs`
- **action.yml is the single entrypoint** — do not add a separate `index.js`; keep all logic in the named scripts
- **Env-driven** — scripts read all config from environment variables set by `action.yml`, not CLI args
- When modifying `validate-modules.cjs`: test against both a flat kit (no `t1k-modules.json`) and a modular kit
- When modifying `send-discord-release.cjs`: respect the Discord newline/embed format — see `~/home/tuha/.claude/discord-webhook-newline-mistake.md`

## Commit Conventions

Uses **conventional commits** (enforced by semantic-release):

| Prefix | Effect |
|--------|--------|
| `feat:` | Minor version bump |
| `fix:` | Patch version bump |
| `chore:`, `docs:`, `refactor:` | No release |
| `feat!:` or `BREAKING CHANGE:` footer | Major version bump |
