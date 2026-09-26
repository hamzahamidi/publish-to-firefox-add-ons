import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { amoClient } from '../src/client.ts';
import { type DownloadOptions, downloadSignedFile } from '../src/download.ts';
import { ActionError } from '../src/errors.ts';
import { ADDON_ID, addonManifest, API_KEY, API_SECRET, makeZip, type MockStore, type Reply, startMockStore } from './helpers.ts';

let server: MockStore;
let other: MockStore;
const dir = mkdtempSync(join(tmpdir(), 'amo-download-'));
before(async () => {
  server = await startMockStore();
  other = await startMockStore();
});
afterEach(() => {
  server.reset();
  other.reset();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
after(async () => {
  await server.close();
  await other.close();
  rmSync(dir, { recursive: true, force: true });
});

const SIGNATURES = ['META-INF/mozilla.rsa', 'META-INF/mozilla.sf', 'META-INF/manifest.mf'];

function signedXpi({ id = ADDON_ID, version = '1.4.0', skip = '' }: { id?: string; version?: string; skip?: string } = {}): Buffer {
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify(addonManifest(version, { id })) },
    ...SIGNATURES.filter((name) => name !== skip).map((name) => ({ name, data: `signature ${name}` })),
  ]);
}

const hashOf = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function download(bytes: Buffer, options: Partial<DownloadOptions> = {}, replies: Reply[] = [{ body: bytes, headers: { 'Content-Type': 'application/x-xpinstall' } }]) {
  server.on('GET /firefox/downloads/file/1/x.xpi', ...replies);
  const target = join(dir, 'out', 'signed.xpi');
  const promise = downloadSignedFile({
    client: amoClient({ apiBase: server.base, apiKey: API_KEY, apiSecret: API_SECRET, sleep: async () => {} }),
    apiBase: server.base,
    url: `${server.base}/firefox/downloads/file/1/x.xpi`,
    hash: hashOf(bytes),
    size: bytes.length,
    target,
    addonId: ADDON_ID,
    version: '1.4.0',
    ...options,
  });
  return Object.assign(promise, { target });
}

async function refused(run: Promise<void> & { target: string }, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error) => error instanceof ActionError && pattern.test(error.details ? `${error.message}\n${error.details}` : error.message));
  assert.equal(existsSync(run.target), false, 'no file at the output path');
  if (existsSync(join(dir, 'out'))) assert.deepEqual(readdirSync(join(dir, 'out')), []);
}

describe('downloadSignedFile', () => {
  it('verifies the signed file and writes it by rename, creating the folder', async () => {
    const bytes = signedXpi();
    const run = download(bytes);
    await run;
    assert.deepEqual(readFileSync(run.target), bytes);
    assert.deepEqual(readdirSync(join(dir, 'out')), ['signed.xpi']);
    assert.match(server.requests[0]!.auth ?? '', /^JWT /);
    const claims = JSON.parse(Buffer.from(server.requests[0]!.auth!.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.exp - claims.iat, 300);
  });

  it('refuses a URL on another origin without sending anything', async () => {
    await refused(download(signedXpi(), { url: `${other.base}/firefox/downloads/file/1/x.xpi` }), /^AMO returned a download URL on 127\.0\.0\.1:\d+\. The action sends the JWT to 127\.0\.0\.1:\d+ only\./);
    await refused(download(signedXpi(), { url: 'https://addons.cdn.mozilla.net/x.xpi' }), /download URL on addons\.cdn\.mozilla\.net\./);
    await refused(download(signedXpi(), { url: undefined }), /download URL on missing\./);
    assert.equal(server.requests.length + other.requests.length, 0);
  });

  it('refuses a missing or non-SHA-256 hash before downloading', async () => {
    await refused(download(signedXpi(), { hash: 'md5:abc' }), /^AMO gave no SHA-256 hash for the signed file; the action does not write an unverified file\.$/);
    await refused(download(signedXpi(), { hash: undefined }), /no SHA-256 hash/);
    assert.equal(server.requests.length, 0);
  });

  it('refuses bytes whose hash or size differ from what AMO reported', async () => {
    const bytes = signedXpi();
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 30] = corrupted[corrupted.length - 30]! ^ 0xff;
    await refused(download(corrupted, { hash: hashOf(bytes) }), /^The downloaded file has SHA-256 [0-9a-f]{64}, but AMO reported [0-9a-f]{64}\. Nothing was written\.$/);
    await refused(download(bytes, { size: bytes.length + 1 }), /has \d+ bytes, but AMO reported \d+\. Nothing was written\./);
    const run = download(bytes, { size: undefined });
    await run;
    assert.ok(existsSync(run.target));
  });

  for (const name of SIGNATURES) {
    it(`refuses a file without ${name}`, async () => {
      await refused(download(signedXpi({ skip: name })), new RegExp(`^The signed file has no ${name.replaceAll('.', '\\.')}, so Mozilla did not sign it\\. Nothing was written\\.$`));
    });
  }

  it('downloads again after a 5xx or a network error', async () => {
    const bytes = signedXpi();
    const run = download(bytes, {}, [{ status: 503 }, { delayMs: 1 }, { body: bytes, headers: { 'Content-Type': 'application/x-xpinstall' } }]);
    await run;
    assert.deepEqual(readFileSync(run.target), bytes);
    assert.equal(server.requests.length, 3);
  });

  it('stops after three failed tries to download, and writes nothing', async () => {
    await refused(download(signedXpi(), {}, [{ status: 500 }, { status: 500 }, { status: 500 }]), /returned HTTP 500/);
    assert.equal(server.requests.length, 3);
  });

  it('refuses a file for another add-on or another version', async () => {
    await refused(download(signedXpi({ id: 'other@example.com' })), /holds version 1\.4\.0 of "other@example\.com", not 1\.4\.0 of my-extension@example\.com/);
    await refused(download(signedXpi({ version: '1.4.1' })), /holds version 1\.4\.1 of "my-extension@example\.com", not 1\.4\.0/);
  });

  it('explains a 404 and a 451, and refuses an answer over the size cap', async () => {
    server.on('GET /firefox/downloads/file/1/x.xpi', { status: 404, body: { detail: 'Not found.' } });
    const target = join(dir, 'x.xpi');
    const base = { client: amoClient({ apiBase: server.base, apiKey: API_KEY, apiSecret: API_SECRET, sleep: async () => {} }), apiBase: server.base, url: `${server.base}/firefox/downloads/file/1/x.xpi`, hash: hashOf(Buffer.from('x')), size: 1, target, addonId: ADDON_ID, version: '1.4.0' };
    await assert.rejects(downloadSignedFile(base), (error) => error instanceof ActionError && /Only an author of the add-on can download an unlisted file; the developer role is enough\./.test(error.details ?? ''));
    server.on('GET /firefox/downloads/file/1/x.xpi', { status: 451, body: { detail: 'Unavailable.' } });
    await assert.rejects(downloadSignedFile(base), (error) => error instanceof ActionError && /AMO restricts this add-on in the runner's country/.test(error.details ?? ''));
    server.on('GET /firefox/downloads/file/1/x.xpi', { body: 'x'.repeat(50) });
    await assert.rejects(downloadSignedFile({ ...base, client: amoClient({ apiBase: server.base, apiKey: API_KEY, apiSecret: API_SECRET, maxBodyBytes: 10 }) }), /larger than 10 bytes/);
    assert.equal(existsSync(target), false);
  });

  it('reports a target it cannot write, and leaves no temporary file', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be');
    const run = download(signedXpi(), { target: join(dir, 'blocker', 'signed.xpi') });
    await assert.rejects(run, /^ActionError: Cannot write ".*signed\.xpi": /);
    assert.deepEqual(readdirSync(dir), ['blocker']);
  });
});
