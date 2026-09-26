import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { USER_AGENT } from '../src/client.ts';
import { ACCOUNT, ADDON_ID, addonZip, API_KEY, sourceZip, unzip } from './helpers.ts';
import { type AmoRequest, startMockAmo } from './mock-amo.ts';

const ZIP = 'self-test.zip';
const SOURCE = 'self-test-source.zip';
const SIGNED = 'self-test-signed/my-extension.xpi';
const PORTS = 'self-test-ports.json';
const SECRET = 'self-test-secret';
const VERSION = '1.4.0';
const RELEASE_NOTES = 'Adds a settings page.';
const APPROVAL_NOTES = 'npm ci && npm run build';
const SCENARIOS = ['listed', 'unlisted', 'rerun'];

const SITE = 'GET /api/v5/site/?disable_caching=1';
const ADDON = `GET /api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/`;
const AUTHOR = `GET /api/v5/addons/addon/1234/authors/${ACCOUNT}/`;
const LOOKUP = `GET /api/v5/addons/addon/1234/versions/v${VERSION}/`;
const LIST = 'GET /api/v5/addons/upload/?page_size=50&page=1';
const UPLOAD = 'POST /api/v5/addons/upload/';
const POLL = 'GET /api/v5/addons/upload/{uuid}/';
const CREATE = 'POST /api/v5/addons/addon/1234/versions/';
const PATCH = 'PATCH /api/v5/addons/addon/1234/versions/{id}/';
const READ = 'GET /api/v5/addons/addon/1234/versions/{id}/';
const DOWNLOAD = `GET /firefox/downloads/file/{id}/my-extension-${VERSION}.xpi`;
const NEW_VERSION = [SITE, ADDON, AUTHOR, LOOKUP, LIST, UPLOAD, POLL, CREATE];
const CRASHED = [...NEW_VERSION, POLL, POLL, POLL];
const COMPLETED = [SITE, ADDON, AUTHOR, LOOKUP, PATCH];
const UNCHANGED = [SITE, ADDON, AUTHOR, LOOKUP];

interface State {
  requests: AmoRequest[];
  versions: Array<{ id: number; version: string; channel: string; fileStatus: string; releaseNotes: Record<string, string> | null; approvalNotes: string; source: string | null; sha256: string }>;
  uploads: Array<{ uuid: string; channel: string; submitted: boolean }>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const [command, scenario = ''] = process.argv.slice(2);

if (command === 'start' && SCENARIOS.includes(scenario)) {
  rmSync(PORTS, { force: true });
  const log = openSync('self-test-server.log', 'w');
  spawn(process.execPath, [import.meta.filename, 'serve', scenario], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 50 && !existsSync(PORTS); i++) await sleep(100);
  if (!existsSync(PORTS)) {
    console.error(readFileSync('self-test-server.log', 'utf8'));
    console.error('The mock AMO did not start within 5 s.');
    process.exit(1);
  }
  const { amo } = JSON.parse(readFileSync(PORTS, 'utf8')) as { amo: number };
  appendFileSync(process.env.GITHUB_ENV ?? '/dev/stdout', `AMO_API_BASE=http://127.0.0.1:${amo}\n`);
  console.log(`Mock AMO listening on http://127.0.0.1:${amo} for the ${scenario} scenario.`);
} else if (command === 'serve' && SCENARIOS.includes(scenario)) {
  writeFileSync(ZIP, addonZip(VERSION));
  writeFileSync(SOURCE, sourceZip());
  const mock = await startMockAmo();
  mock.addAccount({ id: ACCOUNT, key: API_KEY, secret: SECRET });
  mock.addVersion({ version: '1.3.0', channel: 'listed', fileStatus: 'public' });
  if (scenario === 'unlisted') mock.config.signAfterReads = 1;
  if (scenario === 'rerun') {
    mock.fault('version:create', { drop: 'after', then: () => mock.fault('upload', { status: 503 }, { status: 503 }, { status: 503 }) });
  }
  const control = createServer((_, res) => {
    const state: State = {
      requests: mock.requests,
      versions: mock.versions.map(({ id, version, channel, fileStatus, releaseNotes, approvalNotes, source, bytes }) => ({ id, version, channel, fileStatus, releaseNotes, approvalNotes, source, sha256: sha256(bytes) })),
      uploads: mock.uploads.map(({ uuid, channel, submitted }) => ({ uuid, channel, submitted })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  });
  await new Promise<void>((ready) => control.listen(0, '127.0.0.1', ready));
  const ports = { amo: Number(new URL(mock.base).port), control: (control.address() as AddressInfo).port };
  writeFileSync(`${PORTS}.tmp`, JSON.stringify(ports));
  renameSync(`${PORTS}.tmp`, PORTS);
} else if (command === 'verify' && ['listed', 'unlisted', 'rerun-1', 'rerun-2', 'rerun-3'].includes(scenario)) {
  const { amo, control } = JSON.parse(readFileSync(PORTS, 'utf8')) as { amo: number; control: number };
  const state = (await (await fetch(`http://127.0.0.1:${control}/`)).json()) as State;
  const created = state.versions.find((version) => version.version === VERSION);
  const editUrl = (id: number) => `http://127.0.0.1:${amo}/en-US/developers/addon/my-extension/versions/${id}`;
  const env = (name: string) => process.env[name] ?? '';
  const outputs = {
    result: env('RESULT'),
    state: env('STATE'),
    version: env('VERSION'),
    'version-id': env('VERSION_ID'),
    'edit-url': env('EDIT_URL'),
    'signed-xpi': env('SIGNED_XPI'),
  };
  const calls = state.requests.map((request) => request.call.replace(/[0-9a-f]{32}/g, '{uuid}').replace(/\/(versions|file)\/\d+\//, '/$1/{id}/'));

  for (const request of state.requests) {
    assert.equal(request.userAgent, USER_AGENT);
    assert.equal(request.accept, 'application/json');
    assert.equal(request.verdict, request.route === 'site' ? 'none' : 'ok', `${request.call} carried a token the mock refused: ${request.verdict}`);
  }
  const upload = state.requests.find((request) => request.call === UPLOAD);
  if (upload) {
    assert.equal(upload.form?.channel?.value, scenario === 'unlisted' ? 'unlisted' : 'listed');
    assert.equal(upload.form?.upload?.filename, ZIP);
    assert.equal(upload.form?.upload?.sha256, sha256(readFileSync(ZIP)));
  }
  const create = state.requests.find((request) => request.call === CREATE);
  if (create && scenario !== 'unlisted') {
    const { upload: uuid, source, approval_notes: approval, ...rest } = create.form ?? {};
    assert.deepEqual(rest, {});
    assert.equal(uuid?.value, state.uploads[0]?.uuid);
    assert.equal(source?.filename, SOURCE);
    assert.equal(source?.sha256, sha256(readFileSync(SOURCE)));
    assert.equal(approval?.value, APPROVAL_NOTES);
  }
  const patch = state.requests.find((request) => request.method === 'PATCH');
  if (patch) assert.deepEqual(patch.json, { release_notes: { 'en-US': RELEASE_NOTES } });

  assert.ok(created, `the mock holds no version ${VERSION}`);
  assert.equal(state.versions.filter((version) => version.version === VERSION).length, 1);
  assert.deepEqual(
    state.uploads.map((each) => each.submitted),
    [true],
  );

  if (scenario === 'listed') {
    assert.deepEqual(calls, [...NEW_VERSION, PATCH]);
    assert.deepEqual(outputs, { result: 'submitted', state: 'unreviewed', version: VERSION, 'version-id': String(created.id), 'edit-url': editUrl(created.id), 'signed-xpi': '' });
    assert.deepEqual([created.channel, created.releaseNotes, created.approvalNotes, Boolean(created.source)], ['listed', { 'en-US': RELEASE_NOTES }, APPROVAL_NOTES, true]);
  } else if (scenario === 'unlisted') {
    assert.deepEqual(calls, [...NEW_VERSION, READ, DOWNLOAD]);
    assert.deepEqual(create?.json, { upload: state.uploads[0]?.uuid });
    assert.deepEqual(outputs, { result: 'submitted', state: 'public', version: VERSION, 'version-id': String(created.id), 'edit-url': editUrl(created.id), 'signed-xpi': SIGNED });
    const signed = readFileSync(SIGNED);
    assert.equal(sha256(signed), created.sha256);
    const entries = unzip(signed);
    for (const name of ['META-INF/mozilla.rsa', 'META-INF/mozilla.sf', 'META-INF/manifest.mf']) assert.ok(entries.has(name), `the signed file has no ${name}`);
  } else if (scenario === 'rerun-1') {
    assert.equal(process.env.OUTCOME, 'failure');
    assert.deepEqual(calls, CRASHED);
    assert.deepEqual(outputs, { result: '', state: '', version: VERSION, 'version-id': '', 'edit-url': '', 'signed-xpi': '' });
    assert.deepEqual([created.releaseNotes, created.approvalNotes, Boolean(created.source)], [null, APPROVAL_NOTES, true]);
  } else {
    assert.deepEqual(calls, scenario === 'rerun-2' ? [...CRASHED, ...COMPLETED] : [...CRASHED, ...COMPLETED, ...UNCHANGED]);
    assert.deepEqual(outputs, { result: 'skipped', state: 'unreviewed', version: VERSION, 'version-id': String(created.id), 'edit-url': editUrl(created.id), 'signed-xpi': '' });
    assert.deepEqual([created.releaseNotes, created.approvalNotes, Boolean(created.source)], [{ 'en-US': RELEASE_NOTES }, APPROVAL_NOTES, true]);
  }
  console.log(`The action made the expected ${calls.length} requests with valid tokens and set the expected outputs (${scenario}).`);
} else {
  console.error('Usage: node test/self-test.ts start|serve listed|unlisted|rerun, or verify listed|unlisted|rerun-1|rerun-2|rerun-3');
  process.exit(2);
}
