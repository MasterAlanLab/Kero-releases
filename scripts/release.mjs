import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseVersion, prepareReleaseDetails } from './release-details.mjs';

const repository = 'MasterAlanLab/Kero-releases';
// `from` is the packaging suffix, `to` the public one. The Windows hotfix ZIP is
// the installed directory that the in-app updater copies over an installation;
// macOS and Linux updates reuse their installers.
const platforms = {
  windows: [{ key: 'win32-x64', files: [{ role: 'installer', from: 'Setup.exe', to: 'Setup.exe' },
    { role: 'hotfix', from: 'hotfix.zip', to: 'win32-x64-hotfix.zip' }] }],
  macos: [{ key: 'darwin-arm64', files: [{ role: 'installer', from: 'arm64.zip', to: 'arm64.zip' }] },
    { key: 'darwin-x64', files: [{ role: 'installer', from: 'x64.zip', to: 'x64.zip' }] }],
  linux: [{ key: 'linux-x64', files: [{ role: 'installer', from: 'amd64.deb', to: 'amd64.deb' }] }],
};

function check(ok, message) {
  if (!ok) throw new Error(message);
}

export function validateVersion(version) {
  check(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version !== '0.0.0', 'Version must be x.y.z (without v), excluding 0.0.0');
  return version;
}

function validateCommit(sha) {
  check(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha), 'Expected a full source commit SHA');
}

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function digest(file) {
  // Files are read sequentially to keep peak memory bounded to one installer.
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function verifyFile(file, entry) {
  check(statSync(file).isFile() && statSync(file).size > 0 && statSync(file).size === entry.size,
    `Installer size mismatch: ${path.basename(file)}`);
  check(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
    && digest(file) === entry.sha256, `Installer checksum mismatch: ${path.basename(file)}`);
}

function cleanOutput(dir) {
  mkdirSync(dir, { recursive: true });
  check(readdirSync(dir).length === 0, `Output must be empty: ${dir}`);
}

// Only fixed, explicitly supported artifact names are copied. Build-info may
// also list other hotfix files and internal metadata; these never enter public assets.
export function stageInstallers(root, out, { version, sha, platform }) {
  validateVersion(version);
  validateCommit(sha);
  check(Object.hasOwn(platforms, platform), 'Unsupported platform');
  cleanOutput(out);
  const assets = [];
  for (const { key, files } of platforms[platform]) {
    const dir = path.join(root, version, key);
    const info = json(path.join(dir, 'build-info.json'));
    const [os, arch] = key.split('-');
    check(info.schemaVersion === 2 && info.version === version && info.versionless === false
      && info.region === 'global' && info.commitSha === sha && info.platform === os
      && info.arch === arch && info.platformKey === key, `Build identity mismatch: ${key}`);
    check(Array.isArray(info.files), `Missing artifact list: ${key}`);
    for (const { role, from, to } of files) {
      const entries = info.files.filter(file => file.role === role);
      check(entries.length === 1, `Expected one ${role} for ${key}`);
      const entry = entries[0];
      check([`cindy-${version}-${from}`, `kero-${version}-${from}`].includes(entry.name),
        `Unexpected ${role} filename: ${key}`);
      const source = path.join(dir, entry.name);
      verifyFile(source, entry);
      const name = `kero-${version}-${to}`;
      copyFileSync(source, path.join(out, name));
      assets.push({ name, platformKey: key, size: entry.size, sha256: entry.sha256 });
    }
  }
  writeFileSync(path.join(out, `${platform}.json`), JSON.stringify({ version, sha, assets }, null, 2) + '\n');
  return assets;
}

export function assembleRelease(staged, out, { version, sha, notes, buildURL }) {
  validateVersion(version);
  validateCommit(sha);
  check(typeof notes === 'string' && notes.trim().length > 0 && notes.length <= 16000,
    'Provide release notes (1–16000 characters)');
  const assets = [];
  const allowed = [];
  for (const [platform, expected] of Object.entries(platforms)) {
    allowed.push(`${platform}.json`);
    const info = json(path.join(staged, `${platform}.json`));
    const expectedNames = expected.flatMap(({ key, files }) => files.map(({ to }) => ({ key, name: `kero-${version}-${to}` })));
    check(info.version === version && info.sha === sha && Array.isArray(info.assets)
      && info.assets.length === expectedNames.length, `Staged build identity mismatch: ${platform}`);
    for (const { key, name } of expectedNames) {
      const matches = info.assets.filter(asset => asset.name === name && asset.platformKey === key);
      check(matches.length === 1, `Missing installer: ${name}`);
      verifyFile(path.join(staged, name), matches[0]);
      // Whitelist fields rather than publishing arbitrary build metadata.
      const { size, sha256 } = matches[0];
      assets.push({ name, platformKey: key, size, sha256 });
      allowed.push(name);
    }
  }
  check(readdirSync(staged).every(name => allowed.includes(name)), 'Unexpected staged file');
  cleanOutput(out);
  assets.sort((a, b) => a.name.localeCompare(b.name));
  for (const asset of assets) copyFileSync(path.join(staged, asset.name), path.join(out, asset.name));
  writeFileSync(path.join(out, 'SHA256SUMS'), assets.map(a => `${a.sha256}  ${a.name}\n`).join(''));
  writeFileSync(path.join(out, 'release-metadata.json'), JSON.stringify({
    version, sourceRepository: 'MasterAlanLab/Kero', sourceCommit: sha,
    buildURL, region: 'global', assets,
  }, null, 2) + '\n');
  return assets;
}

// REST releases/tags only finds published tags. GraphQL also resolves a draft's
// pending tag, so a failed upload can resume without creating a duplicate draft.
async function inspectRelease(version, { token, request = fetch }) {
  validateVersion(version);
  check(token, 'Missing GitHub Actions token');
  const response = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($tag: String!) { repository(owner: "MasterAlanLab", name: "Kero-releases") { release(tagName: $tag) { isDraft name } } }',
      variables: { tag: `v${version}` },
    }),
    signal: AbortSignal.timeout(30000),
  });
  check(response.ok, `Cannot inspect release state (HTTP ${response.status})`);
  const body = await response.json();
  check(!body.errors?.length && body.data?.repository, 'Cannot inspect release repository');
  const release = body.data.repository.release;
  if (release === null) return null;
  check(typeof release?.isDraft === 'boolean', 'Invalid release state');
  return release;
}

// Preflight can skip a duplicate request; publishing still rejects public tags.
export async function planRelease(version, options) {
  const release = await inspectRelease(version, options);
  return { shouldBuild: release?.isDraft !== false,
    reason: !release ? 'new-release' : release.isDraft ? 'resume-draft' : 'already-published' };
}

export async function lookupRelease(version, options) {
  const release = await inspectRelease(version, options);
  check(release?.isDraft !== false, 'This version is already public; publish a new version instead');
  return release;
}

async function existingRelease(version) {
  check(process.env.GITHUB_REPOSITORY === repository, `Run this workflow in ${repository}`);
  return lookupRelease(version, { token: process.env.GH_TOKEN });
}

function gh(args) {
  execFileSync('gh', [...args, '--repo', repository], { stdio: 'inherit' });
}

async function main() {
  const [command, first, second, detailsFile] = process.argv.slice(2);
  const version = releaseVersion(process.env.KERO_VERSION);
  if (command === 'preflight') {
    check(process.env.GITHUB_REPOSITORY === repository, `Run this workflow in ${repository}`);
    check(process.env.KERO_SOURCE_REF?.trim() && !/[\r\n\0]/.test(process.env.KERO_SOURCE_REF), 'Invalid source ref');
    check((process.env.KERO_NOTES || '').length <= 16000, 'Release notes exceed 16000 characters');
    const plan = await planRelease(version, { token: process.env.GH_TOKEN });
    if (plan.shouldBuild) check(process.env.KERO_SOURCE_TOKEN, 'Configure KERO_SOURCE_TOKEN in repository Actions secrets');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${version}\nshould_build=${plan.shouldBuild}\n`);
    const url = `https://github.com/${repository}/releases/tag/v${version}`;
    const summary = plan.shouldBuild ? `Kero v${version}: ${plan.reason}. Resolve source and build all platforms.\n`
      : `Kero v${version}: already published — skipped.\n\n` +
        `[View the published release](${url}). This run did not build, upload or change assets.\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  const sha = process.env.KERO_SOURCE_SHA;
  if (command === 'details') {
    check(first && second, 'details requires source directory and output file');
    const existing = await existingRelease(version);
    const details = await prepareReleaseDetails(first, {
      version, sha, token: process.env.GH_TOKEN, notes: process.env.KERO_NOTES || '', previousTitle: existing?.name,
    });
    writeFileSync(second, JSON.stringify(details, null, 2) + '\n');
    return;
  }
  if (command === 'stage') {
    check(first && second, 'stage requires artifact root and output directory');
    stageInstallers(first, second, { version, sha, platform: process.env.KERO_PLATFORM });
    return;
  }
  check(command === 'publish' && first && second && detailsFile, 'Expected preflight, details, stage or publish');
  check(['true', 'false'].includes(process.env.KERO_DRAFT)
    && ['true', 'false'].includes(process.env.KERO_PRERELEASE), 'Invalid release flags');
  const existing = await existingRelease(version);
  const details = json(detailsFile);
  check(details.version === version && details.sha === sha, 'Release details do not match build source');
  check(typeof details.title === 'string' && details.title.startsWith(`v${version} -- "`)
    && details.title.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(details.title), 'Invalid daily release title');
  const buildURL = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  assembleRelease(first, second, { version, sha, notes: details.notes, buildURL });
  const notesFile = path.resolve('release-notes.md');
  writeFileSync(notesFile, `${details.notes.trim()}\n\n---\n\n` +
    `安装说明：[下载与安装](https://github.com/${repository}#readme)。macOS 包未经 Apple 公证，Windows 包未签名。\n\n` +
    `源码提交：\`${sha}\` · [构建记录](${buildURL})\n`);
  const tag = `v${version}`;
  if (!existing) {
    gh(['release', 'create', tag, '--draft', '--title', details.title, '--notes-file', notesFile,
      '--target', process.env.GITHUB_SHA, `--prerelease=${process.env.KERO_PRERELEASE}`]);
  } else {
    gh(['release', 'edit', tag, '--title', details.title, '--notes-file', notesFile,
      `--prerelease=${process.env.KERO_PRERELEASE}`]);
  }
  // Recheck before overwriting assets if someone manually published the draft.
  await existingRelease(version);
  gh(['release', 'upload', tag, ...readdirSync(second).sort().map(name => path.join(second, name)), '--clobber']);
  if (process.env.KERO_DRAFT === 'false') {
    gh(['release', 'edit', tag, '--draft=false', `--prerelease=${process.env.KERO_PRERELEASE}`,
      `--latest=${process.env.KERO_PRERELEASE === 'false'}`]);
  }
  const summary = `Kero ${version}: ${process.env.KERO_DRAFT === 'true' ? 'draft' : 'published'}\n\n` +
    `Source commit: \`${sha}\`\n\nhttps://github.com/${repository}/releases\n`;
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
