import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { ACCOUNT, ADDON_ID, addonFiles, addonZip, API_KEY, API_SECRET, divergentZip, makeZip, sourceZip } from './helpers.ts';
import { type MockAmo, startMockAmo } from './mock-amo.ts';

const MAIN = resolve(import.meta.dirname, '../src/main.ts');
const dir = mkdtempSync(join(tmpdir(), 'amo-action-'));
let amo: MockAmo;

before(async () => {
  amo = await startMockAmo();
});
afterEach(() => amo.reset());
after(async () => {
  await amo.close();
  rmSync(dir, { recursive: true, force: true });
});

const SITE = 'GET /api/v5/site/?disable_caching=1';
const ADDON = `GET /api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/`;
const AUTHOR = `GET /api/v5/addons/addon/1234/authors/${ACCOUNT}/`;
const LOOKUP = (version: string) => `GET /api/v5/addons/addon/1234/versions/v${encodeURIComponent(version)}/`;
const LIST = 'GET /api/v5/addons/upload/?page_size=50&page=1';
const UPLOAD = 'POST /api/v5/addons/upload/';
const POLL = 'GET /api/v5/addons/upload/{uuid}/';
const CREATE = 'POST /api/v5/addons/addon/1234/versions/';
const PATCH = (id: number) => `PATCH /api/v5/addons/addon/1234/versions/${id}/`;
const calls = () => amo.calls().map((call) => call.replace(/[0-9a-f]{32}/g, '{uuid}'));

function file(name: string, content: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

interface ActionRun {
  code: number | null;
  stdout: string;
  outputs: Record<string, string>;
}

function start(inputs: Record<string, string>, env: Record<string, string> = {}): { child: ChildProcess; done: Promise<ActionRun> } {
  const output = join(dir, `output-${Math.random().toString(16).slice(2)}`);
  writeFileSync(output, '');
  const inputEnv = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, AMO_API_BASE: amo.base, ...inputEnv, ...env },
  });
  let stdout = '';
  child.stdout!.on('data', (chunk) => (stdout += chunk));
  child.stderr!.on('data', (chunk) => (stdout += chunk));
  const done = new Promise<ActionRun>((resolveRun) => child.on('close', (code) => resolveRun({ code, stdout, outputs: parseOutputs(readFileSync(output, 'utf8')) })));
  return { child, done };
}

const runAction = (inputs: Record<string, string>, env: Record<string, string> = {}) => start(inputs, env).done;

function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const pattern = /^([\w-]+)<<(EOF_[\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm;
  for (const match of text.matchAll(pattern)) if (match[1] !== undefined) outputs[match[1]] = match[3] ?? '';
  return outputs;
}

const baseInputs = (version: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'api-key': API_KEY,
  'api-secret': API_SECRET,
  'addon-id': ADDON_ID,
  zip: file(`ext-${version}.zip`, addonZip(version)),
  channel: 'unlisted',
  wait: 'false',
  'dry-run': 'false',
  ...extra,
});

const lines = (stdout: string) => stdout.split(/\r?\n/).filter(Boolean);
const withoutMaskLines = (stdout: string) =>
  lines(stdout)
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');

describe('action', () => {
  it('publishes a listed version with source and notes, masks every credential and token, and sets the outputs', async () => {
    const source = file('Source Code.ZIP', sourceZip());
    const run = await runAction(baseInputs('2.0.0', { channel: 'Listed', zip: file('my extension.XPI', addonZip('2.0.0')), source, 'release-notes': 'New popup.', 'approval-notes': 'npm ci && npm run build' }));
    assert.equal(run.code, 0, run.stdout);
    const version = amo.versions[0]!;
    assert.deepEqual(calls(), [SITE, ADDON, AUTHOR, LOOKUP('2.0.0'), LIST, UPLOAD, POLL, CREATE, PATCH(version.id)]);
    assert.deepEqual(run.outputs, {
      version: '2.0.0',
      result: 'submitted',
      state: 'unreviewed',
      'version-id': String(version.id),
      'edit-url': `${amo.base}/en-US/developers/addon/my-extension/versions/${version.id}`,
    });
    assert.equal(amo.requests[5]!.form!.upload!.filename, 'my_extension.xpi');
    assert.equal(amo.requests[5]!.form!.channel!.value, 'listed');
    assert.equal(amo.requests[7]!.form!.source!.filename, 'Source_Code.zip');
    assert.match(run.stdout, /^The ZIP holds version 2\.0\.0 of my-extension@example\.com\.$/m);
    assert.match(run.stdout, /^Checked 2 entries of the ZIP and 2 entries of the source ZIP: neither contains the API key or secret\.$/m);
    assert.ok(!run.stdout.includes('developer@example.com') && !run.stdout.includes('Test Developer'), 'the author name and email never reach the log');

    const tokens = amo.requests.map((request) => request.token).filter((token): token is string => Boolean(token));
    assert.equal(tokens.length, amo.requests.length - 1);
    for (const secret of [API_KEY, API_SECRET, ...tokens]) {
      assert.ok(run.stdout.includes(`::add-mask::${secret}`), `expected ${secret.slice(0, 12)} to be masked`);
      assert.ok(!withoutMaskLines(run.stdout).includes(secret), `${secret.slice(0, 12)} leaked`);
      assert.ok(!Object.values(run.outputs).some((value) => value.includes(secret)), 'no output carries a credential');
    }
    const all = lines(run.stdout);
    const firstPlain = all.findIndex((line) => !line.startsWith('::'));
    assert.ok(all.indexOf(`::add-mask::${API_KEY}`) < firstPlain && all.indexOf(`::add-mask::${API_SECRET}`) < firstPlain, 'key and secret are masked before the first log line');
  });

  it('downloads the signed file of an unlisted version, without an action.yml default for wait-timeout', async () => {
    amo.config.signAfterReads = 1;
    const target = join(dir, 'signed', 'ext.xpi');
    const inputs = baseInputs('1.4.0', { 'signed-xpi': target, zip: file('package', addonZip('1.4.0')) });
    delete inputs.wait;
    const run = await runAction(inputs);
    assert.equal(run.code, 0, run.stdout);
    const version = amo.versions[0]!;
    assert.equal(run.outputs['signed-xpi'], target);
    assert.equal(run.outputs.state, 'public');
    assert.equal(run.outputs.result, 'submitted');
    assert.deepEqual(readFileSync(target), version.bytes);
    assert.equal(amo.requests[5]!.form!.upload!.filename, 'package.zip');
    assert.match(run.stdout, /^Waiting up to 15 minutes for AMO to sign version 1\.4\.0\.$/m);
  });

  it('skips an existing version on a re-run and reports it', async () => {
    const version = amo.addVersion({ version: '1.4.0', channel: 'unlisted' });
    const run = await runAction(baseInputs('1.4.0'));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.4.0', result: 'skipped', state: 'unreviewed', 'version-id': String(version.id), 'edit-url': `${amo.base}/en-US/developers/addon/my-extension/versions/${version.id}` });
    assert.match(run.stdout, new RegExp(`^AMO: version 1\\.4\\.0 already exists in the unlisted channel \\(id ${version.id}\\), file status unreviewed\\. Nothing to upload\\.$`, 'm'));
  });

  it('completes the version after a runner killed during the create, with no second upload or create', async () => {
    amo.fault('version:create', { hang: true });
    const inputs = baseInputs('3.0.0', { source: file('src-3.zip', sourceZip()), 'release-notes': 'Notes.' });
    const first = start(inputs);
    for (let i = 0; i < 200 && amo.versions.length === 0; i++) await sleep(25);
    assert.equal(amo.versions.length, 1, 'the mock stored the version');
    first.child.kill('SIGKILL');
    await first.done;

    amo.requests.length = 0;
    const second = await runAction(inputs);
    assert.equal(second.code, 0, second.stdout);
    const version = amo.versions[0]!;
    assert.deepEqual(calls(), [SITE, ADDON, AUTHOR, LOOKUP('3.0.0'), PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'Notes.' } });
    assert.equal(second.outputs.result, 'skipped');
    assert.equal(amo.uploads.filter((upload) => upload.submitted).length, 1);
  });

  it('encodes an ID in braces and a version with a plus sign in every path', async () => {
    const guid = '{12345678-abcd-4ef0-9123-456789abcdef}';
    amo.addon.guid = guid;
    const run = await runAction(baseInputs('1.0.0+build.7', { 'addon-id': guid, zip: file('guid.zip', addonZip('1.0.0+build.7', { id: guid })) }));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(calls()[1], 'GET /api/v5/addons/addon/%7B12345678-abcd-4ef0-9123-456789abcdef%7D/');
    assert.equal(calls()[3], 'GET /api/v5/addons/addon/1234/versions/v1.0.0%2Bbuild.7/');
  });

  it('reads and reports on a dry run without writing, and still scans', async () => {
    const run = await runAction(baseInputs('1.4.0', { 'dry-run': 'true' }));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(calls(), [SITE, ADDON, AUTHOR, LOOKUP('1.4.0'), LIST]);
    assert.deepEqual(run.outputs, { version: '1.4.0', result: 'dry-run', state: '' });

    amo.reset();
    const version = amo.addVersion({ version: '1.4.0', channel: 'unlisted' });
    const existing = await runAction(baseInputs('1.4.0', { 'dry-run': 'TRUE', 'release-notes': 'Notes.' }));
    assert.equal(existing.outputs.result, 'skipped');
    assert.match(existing.stdout, new RegExp(`Dry run: a real run would send PATCH /api/v5/addons/addon/1234/versions/${version.id}/ with the release notes\\.`));
    assert.ok(amo.requests.every((request) => request.method === 'GET'));

    amo.reset();
    const leaking = await runAction(baseInputs('1.4.0', { 'dry-run': 'true', zip: file('leak-dry.zip', addonZip('1.4.0', { files: [{ name: 'k.js', data: API_KEY }] })) }));
    assert.equal(leaking.code, 1);
    assert.equal(amo.requests.length, 0);
  });

  it('keeps hostile AMO text from starting workflow commands', async () => {
    const hostile = 'bad\n::error::owned\r::add-mask::x %0A \u2028::warning::spoof ##[group]g';
    amo.config.notice = hostile;
    amo.config.submitWarning = hostile;
    amo.queueUpload({ messages: [{ type: 'warning', message: hostile, file: hostile, id: [] }] });
    amo.fault('upload:create', { status: 502, body: hostile });
    const warned = await runAction(baseInputs('1.4.0'));
    assert.equal(warned.code, 0, warned.stdout);
    amo.reset();
    amo.fault('addon', { status: 400, body: { detail: hostile } });
    const failed = await runAction(baseInputs('1.4.0'));
    amo.reset();
    amo.fault('addon', { mutate: (body) => ({ ...body, status: hostile }) });
    const unknown = await runAction(baseInputs('1.4.0'));
    for (const run of [warned, failed, unknown]) {
      const all = run.stdout.split(/\r?\n/);
      assert.ok(!all.some((line) => /^[\s\u0085\u2028]*::(error::owned|add-mask::x|warning::spoof)/.test(line)), run.stdout);
      assert.ok(!all.some((line) => /^[\s\u0085\u2028]*##\[group\]/.test(line)), run.stdout);
    }
    assert.match(warned.stdout, /^::warning::AMO notice: bad%0A::error::owned%0D::add-mask::x %250A/m);
    assert.match(warned.stdout, /^The answer to the upload was lost \(POST \/api\/v5\/addons\/upload\/ returned HTTP 502: bad ::error::owned ::add-mask::x %0A  ::warning::spoof ##\[\\group\]g\)\.$/m);
    assert.match(failed.stdout, /^::error::GET .* returned HTTP 400: bad%0A::error::owned/m);
    assert.match(unknown.stdout, /^::error::AMO answered GET .* with status = "bad\\n::error::owned/m);
  });

  it('refuses to send credentials anywhere but AMO or a loopback test server', async () => {
    for (const url of ['https://example.com', 'http://10.0.0.1:8080', 'http://localhost.example.com']) {
      const run = await runAction(baseInputs('1.4.0'), { AMO_API_BASE: url });
      assert.equal(run.code, 1);
      assert.match(run.stdout, /AMO_API_BASE is a test setting and may only point to http:\/\/127\.0\.0\.1, http:\/\/localhost or http:\/\/\[::1\]\./);
    }
    const notUrl = await runAction(baseInputs('1.4.0'), { AMO_API_BASE: 'not a url' });
    assert.match(notUrl.stdout, /AMO_API_BASE is not a URL\./);
    assert.equal(amo.requests.length, 0);
  });

  const zipPath = () => file('same.zip', addonZip('1.0.0'));
  const invalid: Array<[string, () => Record<string, string>, RegExp]> = [
    ['a missing api-key', () => ({ 'api-key': '' }), /Input api-key is required\./],
    ['a missing api-secret', () => ({ 'api-secret': '' }), /Input api-secret is required\./],
    ['an api-key in the wrong format', () => ({ 'api-key': 'user:abc:1' }), /Input api-key must look like user:12345:678, the JWT issuer shown on the API Credentials page\./],
    ['swapped key and secret', () => ({ 'api-key': API_SECRET, 'api-secret': API_KEY }), /Inputs api-key and api-secret look swapped\./],
    ['a JSON secret', () => ({ 'api-secret': '{"key": "user:1:2", "secret": "abc"}' }), /Input api-secret looks like JSON\. Store the key and the secret as two separate secrets/],
    ['a secret with spaces', () => ({ 'api-secret': 'abc def' }), /Input api-secret contains spaces or control characters\./],
    ['a secret over 1,024 characters', () => ({ 'api-secret': 'a'.repeat(1025) }), /Input api-secret is longer than 1,024 characters\./],
    ['an addon-id that is not an ID', () => ({ 'addon-id': 'not an id' }), /Input addon-id must be the add-on ID from browser_specific_settings\.gecko\.id/],
    ['an addon-id in braces that is not a UUID', () => ({ 'addon-id': '{not-a-guid}' }), /Input addon-id must be/],
    ['an addon-id over 80 characters', () => ({ 'addon-id': `${'a'.repeat(80)}@x` }), /Input addon-id must be/],
    ['a missing channel', () => ({ channel: '' }), /Input channel is required\./],
    ['an unknown channel', () => ({ channel: 'public' }), /Input channel must be listed or unlisted, got "public"\./],
    ['a wait that is not boolean', () => ({ wait: 'yes' }), /Input wait must be true or false, got "yes"\./],
    ['a dry-run that is not boolean', () => ({ 'dry-run': 'maybe' }), /Input dry-run must be true or false/],
    ['a wait-timeout of 0', () => ({ wait: 'true', 'wait-timeout': '0' }), /Input wait-timeout must be a whole number of minutes from 1 to 360, got "0"\./],
    ['a wait-timeout of 361', () => ({ wait: 'true', 'wait-timeout': '361' }), /from 1 to 360, got "361"/],
    ['a fractional wait-timeout', () => ({ wait: 'true', 'wait-timeout': '1.5' }), /from 1 to 360, got "1\.5"/],
    ['a wait-timeout without waiting', () => ({ 'wait-timeout': '30' }), /Input wait-timeout needs wait: true or signed-xpi, because the action only waits when asked\./],
    ['signed-xpi with the listed channel', () => ({ channel: 'listed', 'signed-xpi': join(dir, 'x.xpi') }), /Input signed-xpi downloads the signed file of an unlisted version\. A listed version is distributed by addons\.mozilla\.org\./],
    ['approval notes over 3,000 characters', () => ({ 'approval-notes': 'x'.repeat(3412) }), /Input approval-notes has 3,412 characters; AMO accepts at most 3,000\./],
    ['a source that is not a ZIP', () => ({ source: 'source.tar.gz' }), /Input source must be a ZIP of your source code\.%0AIts file name must end in \.zip\./],
    ['a missing ZIP', () => ({ zip: 'nope/ext.zip' }), /Cannot read "nope\/ext\.zip": no such file\./],
    ['a missing source', () => ({ source: 'nope/source.zip' }), /Cannot read "nope\/source\.zip": no such file\./],
    ['a missing zip input', () => ({ zip: '' }), /Input zip is required\./],
    ['source equal to zip', () => ({ zip: zipPath(), source: zipPath() }), /Input source must name a different file than zip\./],
    ['signed-xpi equal to zip', () => ({ zip: zipPath(), 'signed-xpi': zipPath() }), /Input signed-xpi must name a different file than zip and source\./],
  ];
  for (const [label, override, pattern] of invalid) {
    it(`stops before any request on ${label}`, async () => {
      const run = await runAction(baseInputs('1.0.0', override()));
      assert.equal(run.code, 1, run.stdout);
      assert.match(run.stdout, pattern);
      assert.equal(amo.requests.length, 0);
      assert.ok(!withoutMaskLines(run.stdout).includes(API_SECRET));
    });
  }

  const local: Array<[string, () => Record<string, string>, RegExp]> = [
    ['a Gecko ID that differs', () => ({ zip: file('other.zip', addonZip('1.0.0', { id: 'other@example.com' })) }), /"[^"]*other\.zip" is for "other@example\.com", but addon-id is "my-extension@example\.com"\. Nothing was sent\./],
    ['a manifest without a Gecko ID', () => ({ zip: file('noid.zip', addonZip('1.0.0', { id: null })) }), /has no browser_specific_settings\.gecko\.id, so the action cannot confirm this package belongs to my-extension@example\.com/],
    ['a CRX passed as zip', () => ({ zip: file('ext.crx', Buffer.concat([Buffer.from('Cr24'), Buffer.alloc(8), addonZip('1.0.0')])) }), /is a CRX package\. Pass the ZIP; the action reads the manifest and scans the entries before uploading\./],
    ['the secret in a deflated entry of the package', () => ({ zip: file('leak.zip', addonZip('1.0.0', { files: [{ name: 'dist/config.js', data: `const s = "${API_SECRET}";`.repeat(4) }] })) }), /The API secret appears in entry "dist\/config\.js" of "[^"]*leak\.zip"\. AMO revokes a key it finds in an upload\./],
    ['the key in the source ZIP', () => ({ source: file('leak-source.zip', sourceZip([{ name: '.env', data: `AMO_KEY=${API_KEY}` }])) }), /The API key appears in entry "\.env" of "[^"]*leak-source\.zip"/],
    ['a source ZIP with a broken CRC', () => ({ source: file('crc.zip', makeZip([{ name: 'a.ts', data: 'hello', crc: 7 }])) }), /Entry "a\.ts" of "[^"]*crc\.zip" fails its checksum\. The ZIP is damaged\./],
    ['a manifest in a folder', () => ({ zip: file('nested.zip', makeZip([{ name: 'dist/manifest.json', data: '{}' }])) }), /no manifest\.json at its root, only "dist\/manifest\.json"/],
    ...(['low-count', 'zip64-locator', 'shifted-cd'] as const).map((kind): [string, () => Record<string, string>, RegExp] => [
      `a ${kind} archive that hides an entry holding the secret`,
      () => ({ zip: file(`${kind}.zip`, divergentZip(kind, addonFiles('1.0.0', { files: [{ name: 'dist/config.js', data: `const s = "${API_SECRET}";`.repeat(4) }] }))) }),
      /::error::"[^"]*\.zip" is (not a valid ZIP file|a ZIP64 archive)/,
    ]),
  ];
  for (const [label, override, pattern] of local) {
    it(`refuses ${label} with zero requests, without printing a credential`, async () => {
      const run = await runAction(baseInputs('1.0.0', override()));
      assert.equal(run.code, 1, run.stdout);
      assert.match(run.stdout, pattern);
      assert.equal(amo.requests.length, 0);
      assert.ok(!withoutMaskLines(run.stdout).includes(API_SECRET) && !withoutMaskLines(run.stdout).includes(API_KEY));
      assert.equal(run.outputs.version, undefined);
    });
  }

  it('scans a malformed manifest before parsing it, so no message quotes the secret', async () => {
    const secret = `c${API_SECRET.slice(1)}`;
    const manifest = `{"manifest_version": 3, "name": "x", "version": "1.0.0", "api_secret": ${secret}}`;
    const run = await runAction(baseInputs('1.0.0', { 'api-secret': secret, zip: file('echo.zip', makeZip([{ name: 'manifest.json', data: manifest }])) }));
    assert.equal(run.code, 1, run.stdout);
    assert.match(run.stdout, /::error::The API secret appears in entry "manifest\.json" of "[^"]*echo\.zip"\./);
    const plain = withoutMaskLines(run.stdout);
    for (let i = 0; i + 10 <= secret.length; i++) assert.ok(!plain.includes(secret.slice(i, i + 10)), `the log holds ${secret.slice(i, i + 10)}`);
    assert.equal(amo.requests.length, 0);
  });

  it('refuses a package larger than AMO accepts without reading it', { skip: process.platform === 'win32' && 'sparse files' }, async () => {
    const zip = file('huge.zip', Buffer.alloc(0));
    truncateSync(zip, 200_000_001);
    const run = await runAction(baseInputs('1.0.0', { zip }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /"[^"]*huge\.zip" is larger than 200,000,000 bytes, the largest file AMO accepts\./);
    assert.equal(amo.requests.length, 0);
  });

  it('reports a zip path that is a folder', async () => {
    const run = await runAction(baseInputs('1.0.0', { zip: dir }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /^::error::Cannot read "[^"]+": EISDIR/m);
  });
});
