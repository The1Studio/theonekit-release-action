/**
 * send-discord-release.cjs
 * Parse CHANGELOG.md and send a Discord embed notification.
 *
 * Env:
 *   DISCORD_WEBHOOK_URL — Discord webhook URL
 *   DISCORD_THREAD_ID   — Thread ID to post into (optional)
 *   KIT_NAME            — Display name (e.g. "TheOneKit Unity")
 *   GITHUB_REPO         — owner/repo (e.g. "The1Studio/theonekit-unity")
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { URL } = require('node:url');

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const threadId = process.env.DISCORD_THREAD_ID;
const KIT_NAME = process.env.KIT_NAME || 'TheOneKit';
const GITHUB_REPO = process.env.GITHUB_REPO;
const RELEASE_MODE = process.env.RELEASE_MODE || 'semantic';

if (!webhookUrl) {
  console.error('[X] DISCORD_WEBHOOK_URL env var not set');
  process.exit(1);
}
if (!GITHUB_REPO) {
  console.error('[X] GITHUB_REPO env var not set');
  process.exit(1);
}

function extractLatestRelease() {
  const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    return { version: 'Unknown', date: new Date().toISOString().split('T')[0], sections: {} };
  }

  const content = fs.readFileSync(changelogPath, 'utf8');
  const lines = content.split('\n');

  let version = 'Unknown';
  let date = new Date().toISOString().split('T')[0];
  let collecting = false;
  let currentSection = null;
  const sections = {};

  for (const line of lines) {
    const versionMatch = line.match(/^## \[?(\d+\.\d+\.\d+)\]?.*?\((\d{4}-\d{2}-\d{2})\)/);
    if (versionMatch) {
      if (!collecting) {
        version = versionMatch[1];
        date = versionMatch[2];
        collecting = true;
        continue;
      }
      break;
    }
    if (!collecting) continue;

    const sectionMatch = line.match(/^### (.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] = [];
      continue;
    }

    if (currentSection && line.trim().startsWith('*')) {
      const item = line.trim().substring(1).trim();
      if (item) sections[currentSection].push(item);
    }
  }

  return { version, date, sections };
}

/**
 * Extract module release info from the latest GitHub release (for module mode).
 * Reads the release body created by release-modules.cjs via `gh` CLI.
 */
function extractModuleRelease() {
  const { execSync } = require('child_process');
  const date = new Date().toISOString().split('T')[0];

  try {
    const raw = execSync(
      `gh release view --repo "${GITHUB_REPO}" --json tagName,body`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();

    const release = JSON.parse(raw);
    const tagName = release.tagName;
    const body = release.body || '';

    // Parse module versions from body: "- **module-name** `1.2.3`" or "- **module-name** `1.2.3` _(required)_"
    const modules = [];
    const bodyLines = body.split('\n');
    for (const line of bodyLines) {
      const m = line.match(/^\s*-\s+\*\*(.+?)\*\*\s+`(\d+\.\d+\.\d+)`/);
      if (m) modules.push({ name: m[1], version: m[2] });
    }

    // Parse per-module changelogs from "### Changelog" section
    const changelogs = {};
    let inChangelog = false;
    let currentModule = null;
    for (const line of bodyLines) {
      if (line.startsWith('### Changelog')) { inChangelog = true; continue; }
      if (inChangelog && line.startsWith('### ')) break; // next top-level section
      if (!inChangelog) continue;

      const modHeader = line.match(/^#### (.+)/);
      if (modHeader) { currentModule = modHeader[1]; changelogs[currentModule] = []; continue; }
      if (currentModule && line.trim()) {
        changelogs[currentModule].push(line);
      }
    }

    return { tagName, date, modules, changelogs };
  } catch (err) {
    console.warn(`[!] Could not fetch GitHub release: ${err.message}`);
    return { tagName: 'unknown', date, modules: [] };
  }
}

/**
 * Create Discord embed for module releases — shows per-module version bumps.
 */
function createModuleEmbed(release) {
  const color = 0x10b981;
  const title = `📦 ${KIT_NAME} — Module Release`;
  const url = `https://github.com/${GITHUB_REPO}/releases/tag/${release.tagName}`;

  const moduleList = release.modules
    .map((m) => `\`${m.name}\` → **v${m.version}**`)
    .join('\n');

  const description = [
    `📅 Released on ${release.date} • **${release.modules.length} module${release.modules.length !== 1 ? 's' : ''}**`,
    '',
    '```',
    'git pull origin main  # update',
    '```',
  ].join('\n');

  const fields = [];
  if (moduleList) {
    fields.push({ name: '📦 Module Versions', value: moduleList, inline: false });
  }

  // Add per-module changelogs if available
  if (release.changelogs) {
    for (const [modName, lines] of Object.entries(release.changelogs)) {
      if (lines.length === 0) continue;
      let value = lines.join('\n');
      if (value.length > 1024) {
        const at = value.lastIndexOf('\n', 1000);
        value = `${value.substring(0, at > 0 ? at : 1000)}\n... *(truncated)*`;
      }
      fields.push({ name: `📋 ${modName}`, value, inline: false });
    }
  }

  const changeCount = Object.values(release.changelogs || {}).reduce((sum, lines) => sum + lines.length, 0);

  return {
    title,
    description,
    url,
    color,
    timestamp: new Date().toISOString(),
    footer: { text: `${KIT_NAME} • ${release.modules.length} modules • ${changeCount} changes` },
    fields: fields.slice(0, 25),
  };
}

function createEmbed(release) {
  const color = 0x10b981;
  const title = `🚀 ${KIT_NAME} v${release.version}`;
  const url = `https://github.com/${GITHUB_REPO}/releases/tag/v${release.version}`;

  const emojiMap = {
    Features: '🚀', 'Bug Fixes': '🐞', Documentation: '📚',
    'Code Refactoring': '♻️', 'Performance Improvements': '⚡',
    Tests: '✅', Chores: '🔧', CI: '👷',
  };

  const startsWithEmoji = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const fields = [];

  for (const [name, items] of Object.entries(release.sections)) {
    if (items.length === 0) continue;
    const fieldName = startsWithEmoji.test(name) ? name : `${emojiMap[name] || '📌'} ${name}`;
    let fieldValue = items.map((i) => `• ${i}`).join('\n');
    if (fieldValue.length > 1024) {
      const at = fieldValue.lastIndexOf('\n', 1000);
      fieldValue = `${fieldValue.substring(0, at > 0 ? at : 1000)}\n... *(truncated)*`;
    }
    fields.push({ name: fieldName, value: fieldValue, inline: false });
  }

  const itemCount = Object.values(release.sections).flat().length;
  const description = [
    `📅 Released on ${release.date} • **${itemCount} change${itemCount !== 1 ? 's' : ''}**`,
    '',
    '```',
    'git pull origin main  # update',
    '```',
  ].join('\n');

  return {
    title,
    description,
    url,
    color,
    timestamp: new Date().toISOString(),
    footer: { text: `${KIT_NAME} • ${itemCount} changes` },
    fields: fields.slice(0, 25),
  };
}

function sendToDiscord(embed) {
  const payload = {
    username: 'TheOneKit Release Bot',
    embeds: [embed],
  };

  const parsedUrl = new URL(webhookUrl);
  if (threadId) parsedUrl.searchParams.set('thread_id', threadId);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('[OK] Discord notification sent');
      } else {
        console.error(`[X] Discord webhook failed: ${res.statusCode}`);
        console.error(data);
        process.exit(1);
      }
    });
  });

  req.setTimeout(10000, () => { console.error('[X] Timeout'); req.destroy(); process.exit(1); });
  req.on('error', (err) => { console.error('[X] Error:', err); process.exit(1); });
  req.write(JSON.stringify(payload));
  req.end();
}

try {
  if (RELEASE_MODE === 'modules') {
    const release = extractModuleRelease();
    console.log(`[i] Preparing module notification for ${release.tagName} (${release.modules.length} modules)`);
    if (release.modules.length === 0) { console.log('[i] No modules in release — skipping'); process.exit(0); }
    sendToDiscord(createModuleEmbed(release));
  } else {
    const release = extractLatestRelease();
    console.log(`[i] Preparing notification for v${release.version}`);
    const itemCount = Object.values(release.sections).flat().length;
    if (itemCount === 0) { console.log('[i] No changelog items — skipping'); process.exit(0); }
    sendToDiscord(createEmbed(release));
  }
} catch (err) {
  console.error('[X]', err);
  process.exit(1);
}
