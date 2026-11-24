// Production entry: stageInstallers / assembleRelease, the same functions used
// by Actions. Protects the release contract: complete installers from one
// version/commit only; the Windows update ZIP is the only public hotfix and no
// internal metadata is published. No existing tests existed in this new repo.
// Minimal failures: a mismatched commit, changed installer bytes, a missing
// platform or Windows update ZIP, or an extra hotfix file. Tier: unit with tiny
// synthetic files in isolated OS temp directories; no network/processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleRelease, stageInstallers, validateVersion, lookupRelease, planRelease } from './release.mjs';
import { dailyTitle, prepareReleaseDetails, releaseVersion } from './release-details.mjs';

const sha = 'a'.repeat(40);
const version = '1.2.3';
const options = { version, sha, notes: '修复启动问题。', buildURL: 'https://example.invalid/build/1' };

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kero-releases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, 'artifacts');
  const staged = path.join(root, 'staged');
  mkdirSync(staged);
  for (const [key, suffix] of [['win32-x64', 'Setup.exe'], ['darwin-arm64', 'arm64.zip'],
    ['darwin-x64', 'x64.zip'], ['linux-x64', 'amd64.deb']]) {
    const dir = path.join(artifacts, version, key);
    mkdirSync(dir, { recursive: true });
    const artifact = (role, name) => {
      const data = Buffer.from(`synthetic ${role} ${key}`);
      writeFileSync(path.join(dir, name), data);
      return { role, name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    };
    const [platform, arch] = key.split('-');
    writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({
      schemaVersion: 2, version, versionless: false, commitSha: sha, region: 'global',
      platform, arch, platformKey: key, privateBuildNote: 'must not be copied',
      files: [artifact('installer', `cindy-${version}-${suffix}`), platform === 'win32'
        ? artifact('hotfix', `cindy-${version}-hotfix.zip`) : { role: 'hotfix', name: 'internal-hotfix.zip' }],
    }));
  }
  const stage = (platform) => {
    const out = path.join(root, platform);
    const assets = stageInstallers(artifacts, out, { ...options, platform });
    for (const file of readdirSync(out)) {
      writeFileSync(path.join(staged, file), readFileSync(path.join(out, file)));
    }
    return assets;
  };
  return { root, artifacts, staged, stage, out: path.join(root, 'dist') };
}

test('rejects placeholder and malformed release versions before any build', () => {
  for (const bad of ['0.0.0', 'v1.2.3', '1.2.3-beta', '01.2.3', '1.2.3\nother=value', '$(id)']) {
    assert.throws(() => validateVersion(bad), /Version must/);
  }
  assert.equal(validateVersion(version), version);
});

// Regression: the REST tag endpoint misses a draft whose tag is not yet
// published. The real lookup must recognize that pending tag and allow resume,
// while rejecting public releases and permission/API errors. Tier: unit.
test('finds pending draft tags for retry and blocks published versions and API failures', async () => {
  const token = 'synthetic-test-token';
  const request = (release) => async (url, init) => {
    if (url !== 'https://api.github.com/graphql' || JSON.parse(init.body).variables.tag !== 'v1.2.3') {
      return new Response('{}', { status: 404 });
    }
    return new Response(JSON.stringify({ data: { repository: { release } } }));
  };
  assert.deepEqual(await lookupRelease(version, { token, request: request({ isDraft: true }) }), { isDraft: true });
  assert.equal(await lookupRelease(version, { token, request: request(null) }), null);
  await assert.rejects(lookupRelease(version, { token, request: request({ isDraft: false }) }), /already public/);
  await assert.rejects(lookupRelease(version, { token, request: async () => new Response('{}', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(lookupRelease(version, { token, request: async () => new Response(JSON.stringify({
    errors: [{ message: 'not authorized' }], data: { repository: null },
  })) }), /Cannot inspect release repository/);
});

// Regression: a queued tag run followed a successful manual run for v1.0.0
// and falsely looked like a failed release. Production preflight must skip the
// public version while the publish gate must still reject overwrites. Existing
// lookup tests only covered the strict publish gate. Tier: offline unit.
// Measured 2026-11-17: the complete file ran in 0.13 s (Node test runner).
test('preflight skips duplicate published versions while drafts and new versions still build', async () => {
  let release = null;
  const opts = { token: 'synthetic-test-token', request: async () => Response.json({ data: { repository: { release } } }) };
  assert.deepEqual(await planRelease(version, opts), { shouldBuild: true, reason: 'new-release' });
  release = { isDraft: true };
  assert.deepEqual(await planRelease(version, opts), { shouldBuild: true, reason: 'resume-draft' });
  release = { isDraft: false };
  assert.deepEqual(await planRelease(version, opts), { shouldBuild: false, reason: 'already-published' });
  await assert.rejects(lookupRelease(version, opts), /already public/);
  release = {};
  await assert.rejects(planRelease(version, opts), /Invalid release state/);
  await assert.rejects(planRelease(version, { ...opts, request: async () => new Response('', { status: 403 }) }), /HTTP 403/);
});

test('assembles renamed installers, the Windows update ZIP and reproducible checksums; excludes internal build data', t => {
  const f = fixture(t);
  for (const platform of ['windows', 'macos', 'linux']) f.stage(platform);
  const assets = assembleRelease(f.staged, f.out, options);
  assert.equal(assets.length, 5);
  assert.deepEqual(readdirSync(f.out).sort(), ['SHA256SUMS', 'kero-1.2.3-Setup.exe', 'kero-1.2.3-win32-x64-hotfix.zip',
    'kero-1.2.3-amd64.deb', 'kero-1.2.3-arm64.zip', 'kero-1.2.3-x64.zip', 'release-metadata.json'].sort());
  assert.equal(readFileSync(path.join(f.out, 'kero-1.2.3-arm64.zip'), 'utf8'), 'synthetic installer darwin-arm64');
  assert.equal(readFileSync(path.join(f.out, 'kero-1.2.3-win32-x64-hotfix.zip'), 'utf8'), 'synthetic hotfix win32-x64');
  assert.equal(readFileSync(path.join(f.out, 'SHA256SUMS'), 'utf8'),
    assets.map(a => `${createHash('sha256').update(readFileSync(path.join(f.out, a.name))).digest('hex')}  ${a.name}\n`).join(''));
  const metadata = JSON.parse(readFileSync(path.join(f.out, 'release-metadata.json')));
  assert.equal(metadata.sourceCommit, sha);
  assert.equal(JSON.stringify(metadata).includes('privateBuildNote'), false);
});

test('rejects wrong version, source commit or platform identity from build-info', t => {
  const f = fixture(t);
  const manifest = path.join(f.artifacts, version, 'win32-x64', 'build-info.json');
  const original = JSON.parse(readFileSync(manifest));
  for (const change of [{ version: '1.2.4' }, { commitSha: 'b'.repeat(40) },
    { arch: 'arm64' }, { region: 'cn' }, { versionless: true }]) {
    writeFileSync(manifest, JSON.stringify({ ...original, ...change }));
    assert.throws(() => stageInstallers(f.artifacts, path.join(f.root, `bad-${Object.keys(change)[0]}`),
      { ...options, platform: 'windows' }), /Build identity mismatch/);
  }
});

test('rejects tampered bytes at staging and again before release publication', t => {
  const f = fixture(t);
  const file = path.join(f.artifacts, version, 'win32-x64', `cindy-${version}-Setup.exe`);
  const data = readFileSync(file);
  writeFileSync(file, Buffer.alloc(data.length, 0));
  assert.throws(() => f.stage('windows'), /checksum mismatch/);
  writeFileSync(file, data);
  for (const platform of ['windows', 'macos', 'linux']) f.stage(platform);
  writeFileSync(path.join(f.staged, `kero-${version}-Setup.exe`), Buffer.alloc(data.length, 0));
  assert.throws(() => assembleRelease(f.staged, f.out, options), /checksum mismatch/);
});

test('rejects a missing platform, Windows update ZIP or unexpected staged hotfix rather than publishing a partial release', t => {
  const f = fixture(t);
  const manifest = path.join(f.artifacts, version, 'win32-x64', 'build-info.json');
  const original = JSON.parse(readFileSync(manifest));
  writeFileSync(manifest, JSON.stringify({ ...original, files: original.files.filter(file => file.role !== 'hotfix') }));
  assert.throws(() => stageInstallers(f.artifacts, path.join(f.root, 'no-hotfix'),
    { ...options, platform: 'windows' }), /Expected one hotfix/);
  writeFileSync(manifest, JSON.stringify(original));
  f.stage('windows');
  assert.throws(() => assembleRelease(f.staged, f.out, options), /ENOENT/);
  f.stage('macos');
  f.stage('linux');
  writeFileSync(path.join(f.staged, 'unexpected-hotfix.zip'), 'internal');
  assert.throws(() => assembleRelease(f.staged, f.out, options), /Unexpected staged file/);
});

test('rejects manifest installer path traversal and mixed commits between platform artifacts', t => {
  const f = fixture(t);
  const manifest = path.join(f.artifacts, version, 'win32-x64', 'build-info.json');
  const original = JSON.parse(readFileSync(manifest));
  const invalid = structuredClone(original);
  invalid.files[0].name = '../secret';
  writeFileSync(manifest, JSON.stringify(invalid));
  assert.throws(() => f.stage('windows'), /Unexpected installer filename/);
  writeFileSync(manifest, JSON.stringify(original));
  for (const platform of ['windows', 'macos', 'linux']) f.stage(platform);
  const stagedInfo = path.join(f.staged, 'linux.json');
  const info = JSON.parse(readFileSync(stagedInfo));
  writeFileSync(stagedInfo, JSON.stringify({ ...info, sha: 'b'.repeat(40) }));
  assert.throws(() => assembleRelease(f.staged, f.out, options), /Staged build identity mismatch/);
});

// Production entry: prepareReleaseDetails, used by the workflow before builds.
// User request: automatic source changelog and emailbox-style daily titles.
// Existing artifact tests do not exercise release text. Minimal failures:
// a tag's v prefix, a quote outage, a wrong source baseline, or long emoji text.
// Tier: unit; injected HTTP/Git responses, no network or subprocesses.
// Measured on 2026-11-16: the complete file ran in 0.12 s (Node test runner).
test('normalizes pushed tags into versions accepted by packaging and artifact verification', () => {
  assert.equal(validateVersion(releaseVersion('v1.2.3')), version);
  assert.equal(releaseVersion(version), version);
  for (const bad of ['v0.0.0', 'v1.2.3-beta', 'v01.2.3', 'v1.2.3\n', '$(id)', undefined]) {
    assert.throws(() => releaseVersion(bad), /Version must/);
  }
});

test('daily titles clean remote text, fit publication limits, and fall back on service errors', async () => {
  assert.equal(await dailyTitle(version, { request: async () => Response.json({ hitokoto: '  星光\n不负\u202e赶路人。 ' }) }),
    'v1.2.3 -- "星光不负赶路人。"');
  const emoji = await dailyTitle(version, { request: async () => Response.json({ hitokoto: '🌟'.repeat(100) }) });
  assert.ok(emoji.length <= 160);
  assert.ok(emoji.isWellFormed());
  for (const request of [async () => { throw new Error('timeout'); },
    async () => new Response('<html>outage</html>'), async () => new Response('', { status: 503 }),
    async () => Response.json({ hitokoto: '\r\n' })]) {
    assert.equal(await dailyTitle(version, { request }), 'v1.2.3 -- "Stay hungry, stay foolish."');
  }
  const previousTitle = 'v1.2.3 -- "保持同一句。"';
  assert.equal(await dailyTitle(version, { previousTitle, request: async () => { throw new Error('offline'); } }), previousTitle);
});

const metadataURL = 'https://github.com/MasterAlanLab/Kero-releases/releases/download/v1.2.2/release-metadata.json';
const baseline = 'b'.repeat(40);

function detailsOptions({ previous = baseline, log = '修复启动 (1234567)', metadata = {}, assetURL = metadataURL } = {}) {
  return {
    version, sha, token: 'synthetic-test-token',
    runGit: args => {
      if (args[0] === 'rev-parse') return sha;
      if (args[0] === 'merge-base' && args[2] === previous && args[3] === sha) return '';
      if (args[0] === 'log' && args.at(-1) === (previous ? `${previous}..${sha}` : sha)) return log;
      throw new Error('Unexpected source range');
    },
    request: async (url, init) => {
      if (url === 'https://v1.hitokoto.cn/') return Response.json({ hitokoto: '每日一句。' });
      if (url === 'https://api.github.com/repos/MasterAlanLab/Kero-releases/releases/latest') {
        assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token');
        return previous ? Response.json({ assets: [{ name: 'release-metadata.json', browser_download_url: assetURL }] })
          : new Response('', { status: 404 });
      }
      if (url === metadataURL) {
        assert.equal(init.headers, undefined); // Never send the token to the public asset/CDN.
        return Response.json({ sourceRepository: 'MasterAlanLab/Kero', sourceCommit: previous, ...metadata });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
}

test('generates first-release history and subsequent source changes using the last public metadata', async () => {
  for (const previous of [null, baseline]) {
    const details = await prepareReleaseDetails('/unused', detailsOptions({ previous }));
    assert.deepEqual(details, { version, sha, title: 'v1.2.3 -- "每日一句。"', notes: '## 更新内容\n\n- 修复启动 (1234567)' });
  }
  const empty = await prepareReleaseDetails('/unused', detailsOptions({ log: '' }));
  assert.equal(empty.notes, '## 更新内容\n\n- 重新构建客户端安装包。');
});

test('bounds long changelogs without blocking automatic release or splitting Unicode characters', async () => {
  const log = Array.from({ length: 101 }, (_, i) => `${i} ${'🌟'.repeat(150)}`).join('\n');
  const details = await prepareReleaseDetails('/unused', detailsOptions({ log }));
  assert.ok(details.notes.length <= 16000);
  assert.ok(details.notes.isWellFormed());
  assert.match(details.notes, /另有 1 条提交未展开/);
});

test('rejects untrusted source baselines and mismatched checkouts; explicit notes can reset the baseline', async () => {
  for (const overrides of [{ metadata: { sourceCommit: 'not-a-sha' } },
    { metadata: { sourceRepository: 'someone/else' } }, { assetURL: 'https://example.invalid/metadata.json' }]) {
    await assert.rejects(prepareReleaseDetails('/unused', detailsOptions(overrides)), /Invalid (previous source commit|source metadata URL)/);
  }
  const opts = detailsOptions();
  const originalGit = opts.runGit;
  opts.runGit = args => {
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
    return originalGit(args);
  };
  await assert.rejects(prepareReleaseDetails('/unused', opts), /not an ancestor/);
  const explicit = await prepareReleaseDetails('/unused', { ...opts, notes: ' 手写说明。 ',
    request: async url => {
      assert.equal(url, 'https://v1.hitokoto.cn/');
      return Response.json({ hitokoto: '每日一句。' });
    } });
  assert.equal(explicit.notes, '手写说明。');
  await assert.rejects(prepareReleaseDetails('/unused', { ...opts, runGit: () => baseline }), /does not match build source/);
  await assert.rejects(prepareReleaseDetails('/unused', { ...opts,
    request: async () => new Response('', { status: 403 }) }), /HTTP 403/);
});
