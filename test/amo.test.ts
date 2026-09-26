import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { type PublishOptions, type PublishResult, publishToAmo } from '../src/amo.ts';
import { ActionError } from '../src/errors.ts';
import { ACCOUNT, ADDON_ID, addonZip, API_KEY, API_SECRET, sourceZip, startMockStore } from './helpers.ts';
import { type MockAmo, type MockVersion, startMockAmo } from './mock-amo.ts';

let amo: MockAmo;
const dir = mkdtempSync(join(tmpdir(), 'amo-flow-'));
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
const LIST = (page = 1) => `GET /api/v5/addons/upload/?page_size=50&page=${page}`;
const UPLOAD = 'POST /api/v5/addons/upload/';
const POLL = 'GET /api/v5/addons/upload/{uuid}/';
const CREATE = 'POST /api/v5/addons/addon/1234/versions/';
const PATCH = (id: number) => `PATCH /api/v5/addons/addon/1234/versions/${id}/`;
const VERSION = (id: number) => `GET /api/v5/addons/addon/1234/versions/${id}/`;
const PREFLIGHT = (version: string) => [SITE, ADDON, AUTHOR, LOOKUP(version)];
const NEW_VERSION = (version: string) => [...PREFLIGHT(version), LIST(), UPLOAD, POLL];

interface Run extends Promise<PublishResult> {
  lines: string[];
  warnings: string[];
  outputs: Record<string, string>;
  masked: string[];
  slept: number[];
}

function publish(version: string, options: Partial<PublishOptions> = {}): Run {
  const lines: string[] = [];
  const warnings: string[] = [];
  const outputs: Record<string, string> = {};
  const masked: string[] = [];
  const slept: number[] = [];
  const promise = publishToAmo({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    addonId: ADDON_ID,
    version,
    channel: 'unlisted',
    zip: addonZip(version),
    zipName: 'extension.zip',
    timing: { validationChecks: 6 },
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    mask: (value) => masked.push(value),
    output: (name, value) => {
      outputs[name] = value;
    },
    ...options,
    apiBase: amo.base,
  });
  return Object.assign(promise, { lines, warnings, outputs, masked, slept });
}

const calls = () => amo.calls().map((call) => call.replace(/[0-9a-f]{32}/g, '{uuid}'));
const count = (call: string) => calls().filter((each) => each === call).length;
const only = <T>(items: T[]): T => {
  assert.equal(items.length, 1, `expected exactly one, got ${items.length}`);
  return items[0]!;
};
const created = (version?: string) => only(amo.versions.filter((each) => version === undefined || each.version === version));

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  const error: unknown = await promise.then(
    () => assert.fail('expected the run to fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof ActionError, `expected ActionError, got ${(error as Error)?.stack ?? error}`);
  return error;
}

const text = (error: ActionError) => (error.details ? `${error.message}\n${error.details}` : error.message);

const seed = (version: string, extra: Partial<MockVersion> = {}) => amo.addVersion({ version, channel: 'unlisted', ...extra });
const writes = () => calls().filter((call) => !call.startsWith('GET'));

describe('publishToAmo: new versions', () => {
  it('uploads a new unlisted version, waits for validation and creates it with the notes in one JSON request', async () => {
    const run = publish('1.4.0', { releaseNotes: 'Fixes.', approvalNotes: 'Build with npm run build.' });
    assert.deepEqual(await run, { result: 'submitted', state: 'unreviewed', versionId: created().id });
    assert.deepEqual(calls(), [...NEW_VERSION('1.4.0'), CREATE]);
    const upload = amo.requests[5]!;
    assert.deepEqual(upload.form, {
      channel: { value: 'unlisted' },
      upload: { filename: 'extension.zip', size: addonZip('1.4.0').length, sha256: createHash('sha256').update(addonZip('1.4.0')).digest('hex') },
    });
    const create = amo.requests.at(-1)!;
    assert.deepEqual(create.json, { upload: only(amo.uploads).uuid, release_notes: { 'en-US': 'Fixes.' }, approval_notes: 'Build with npm run build.' });
    assert.equal(create.contentType, 'application/json');
    assert.deepEqual(run.outputs, {
      result: 'submitted',
      state: 'unreviewed',
      'version-id': String(created().id),
      'edit-url': `${amo.base}/en-US/developers/addon/my-extension/versions/${created().id}`,
    });
    assert.ok(run.lines.includes('AMO: add-on my-extension@example.com is public, and this account is a developer of it.'));
    assert.ok(run.lines.includes('AMO: version 1.4.0 does not exist yet.'));
    assert.ok(run.lines.includes('Uploaded extension.zip (1 KB) to the unlisted channel. AMO is validating it.'));
    assert.ok(run.lines.includes(`Created version 1.4.0 (id ${created().id}) in the unlisted channel, with release notes and approval notes. File status: unreviewed.`));
    assert.deepEqual(run.slept, [2000]);
    assert.ok(amo.requests.every((request) => request.verdict === (request.route === 'site' ? 'none' : 'ok')));
    assert.equal(only(amo.uploads).submitted, true);
  });

  it('sends no credential to the site status and masks every token before the request that carries it', async () => {
    const events: string[] = [];
    amo.onRequest = (request) => events.push(`request ${request.token ?? '-'}`);
    const run = publish('1.4.0', { mask: (value) => events.push(`mask ${value}`) });
    await run;
    assert.equal(amo.requests[0]!.auth, undefined);
    assert.ok(amo.requests[0]!.url.includes('disable_caching=1'));
    for (const request of amo.requests.slice(1)) {
      assert.ok(request.token, `${request.call} carries a JWT`);
      assert.ok(events.indexOf(`mask ${request.token}`) >= 0 && events.indexOf(`mask ${request.token}`) < events.indexOf(`request ${request.token}`));
      assert.match(request.userAgent ?? '', /^publish-to-firefox-add-ons\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/hamzahamidi\/publish-to-firefox-add-ons\)$/);
      assert.equal(request.accept, 'application/json');
    }
    assert.equal(new Set(amo.requests.slice(1).map((request) => request.token)).size, amo.requests.length - 1, 'one token per request');
  });

  it('creates a listed version with the source ZIP and approval notes in one multipart request, then sets the release notes', async () => {
    const source = sourceZip();
    const run = publish('2.0.0', { channel: 'listed', source, sourceName: 'source.zip', releaseNotes: 'New popup.', approvalNotes: 'npm ci && npm run build' });
    assert.equal((await run).result, 'submitted');
    const version = created();
    assert.deepEqual(calls(), [...NEW_VERSION('2.0.0'), CREATE, PATCH(version.id)]);
    const create = amo.requests.at(-2)!;
    assert.deepEqual(Object.keys(create.form!).sort(), ['approval_notes', 'source', 'upload']);
    assert.deepEqual(create.form!.source, { filename: 'source.zip', size: source.length, sha256: createHash('sha256').update(source).digest('hex') });
    assert.equal(create.form!.approval_notes!.value, 'npm ci && npm run build');
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'New popup.' } });
    assert.equal(writes().filter((call) => call !== UPLOAD).length, 2, 'two submissions');
    assert.equal(version.approvalNotes, 'npm ci && npm run build');
    assert.deepEqual(version.releaseNotes, { 'en-US': 'New popup.' });
    assert.match(version.source ?? '', /source\.zip$/);
    assert.ok(run.lines.includes(`Created version 2.0.0 (id ${version.id}) in the listed channel, with the source ZIP and approval notes. File status: unreviewed.`));
    assert.ok(run.lines.includes('Set the release notes.'));
    assert.ok(run.lines.some((line) => line.startsWith('Mozilla reviews listed versions; signing can take 24 hours or longer') && line.endsWith(`/versions/${version.id}`)));
  });

  it('adds the approval notes to the release notes PATCH when the multipart create does not store them', async () => {
    amo.config.multipartApprovalNotes = false;
    const run = publish('2.0.0', { channel: 'listed', source: sourceZip(), releaseNotes: 'New popup.', approvalNotes: 'npm run build' });
    await run;
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'New popup.' }, approval_notes: 'npm run build' });
    assert.equal(created().approvalNotes, 'npm run build');
    assert.ok(run.lines.includes('Set the release notes and approval notes.'));
  });

  it('needs one submission with source and approval notes when the create stores the notes', async () => {
    await publish('2.0.0', { source: sourceZip(), approvalNotes: 'npm run build' });
    assert.deepEqual(writes(), [UPLOAD, CREATE]);
  });

  it('reports earlier unsubmitted uploads of this version and uploads again, never reusing them', async () => {
    amo.addUpload({ manifestVersion: '1.4.0', channel: 'unlisted', versionOverride: undefined });
    amo.addUpload({ manifestVersion: '1.4.0', channel: 'unlisted' });
    amo.addUpload({ manifestVersion: '1.4.0', channel: 'listed' });
    amo.addUpload({ manifestVersion: '1.3.0', channel: 'unlisted', submitted: true });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(UPLOAD), 1);
    assert.ok(run.lines.includes('AMO holds 2 unsubmitted uploads of version 1.4.0 (unlisted) from earlier runs. AMO keeps no hash of them, so this run uploads again. AMO deletes them after 15 days.'));
    assert.equal(amo.uploads.filter((upload) => upload.submitted).length, 2);
  });

  it('reads every page of the upload list', async () => {
    amo.config.pageSize = 2;
    for (let i = 0; i < 5; i++) amo.addUpload({ manifestVersion: `0.${i}`, channel: 'unlisted' });
    const run = publish('1.4.0');
    await run;
    assert.deepEqual(calls().slice(4, 7), [LIST(1), LIST(2), LIST(3)]);
    assert.ok(!run.lines.some((line) => line.includes('incomplete')));
  });

  it('marks the snapshot incomplete after 20 pages, on a failed page, and on a count that does not add up', async () => {
    amo.config.pageSize = 1;
    for (let i = 0; i < 21; i++) amo.addUpload({ manifestVersion: `0.${i}` });
    const many = publish('1.4.0');
    await many;
    assert.equal(calls().filter((call) => call.startsWith('GET /api/v5/addons/upload/?')).length, 20);
    assert.ok(many.lines.includes('The upload list is incomplete (more than 20 pages), so this run will not adopt an upload after a lost answer.'));

    amo.reset();
    amo.fault('upload:list', { status: 500 }, { status: 500 }, { status: 500 });
    const failed = publish('1.4.0');
    assert.equal((await failed).result, 'submitted');
    assert.ok(failed.lines.some((line) => /^The upload list is incomplete \(GET \/api\/v5\/addons\/upload\/\?page_size=50&page=1 returned HTTP 500/.test(line)));

    amo.reset();
    amo.fault('upload:list', { status: 404, body: { detail: 'Not found.' } });
    const missing = publish('1.4.0');
    await missing;
    assert.ok(missing.lines.includes('The upload list is incomplete (page 1 answered HTTP 404 without a readable list), so this run will not adopt an upload after a lost answer.'));

    amo.reset();
    amo.addUpload({});
    amo.fault('upload:list', { mutate: (body) => ({ ...body, count: 7, results: [...body.results, { uuid: 5 }] }) });
    const odd = publish('1.4.0');
    await odd;
    assert.ok(odd.lines.some((line) => line.startsWith('An item of the upload list has fields the action cannot read: {"uuid":5}.')));
    assert.ok(odd.lines.includes('The upload list is incomplete (1 distinct uploads across the pages, but a count of 7), so this run will not adopt an upload after a lost answer.'));
  });
});

describe('publishToAmo: lost answers and crashes', () => {
  it('resolves a create whose response was lost in the same run: submitted, one version, one create', async () => {
    amo.fault('version:create', { drop: 'after' });
    const run = publish('1.4.0', { releaseNotes: 'Notes.' });
    assert.equal((await run).result, 'submitted');
    assert.deepEqual(calls(), [...NEW_VERSION('1.4.0'), CREATE, POLL, LOOKUP('1.4.0')]);
    assert.equal(created().version, '1.4.0');
    assert.ok(run.lines.includes('AMO created version 1.4.0; its response was lost.'));
    assert.equal(run.outputs.result, 'submitted');
    assert.equal(run.slept.filter((ms) => ms === 5000).length, 1);
  });

  it('stops with an unknown state when the runner loses the create answer and cannot read back, then a re-run completes the notes', async () => {
    const options: Partial<PublishOptions> = { channel: 'listed', source: sourceZip(), releaseNotes: 'Notes.', approvalNotes: 'npm run build' };
    amo.fault('version:create', {
      drop: 'after',
      then: () => {
        amo.fault('upload', { status: 503 }, { status: 503 }, { status: 503 });
      },
    });
    const first = publish('3.0.0', options);
    const error = await rejection(first);
    assert.match(error.message, /^Version 3\.0\.0 may have been created, but its state is unknown: GET \/api\/v5\/addons\/upload\/[0-9a-f]{32}\/ returned HTTP 503/);
    assert.match(error.details ?? '', /Re-running is safe: the action looks the version up first\./);
    assert.equal(first.outputs.result, undefined);

    amo.requests.length = 0;
    const second = publish('3.0.0', options);
    assert.equal((await second).result, 'skipped');
    const version = created();
    assert.deepEqual(calls(), [...PREFLIGHT('3.0.0'), PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'Notes.' } });
    assert.match(version.source ?? '', /source\.zip$/);
    assert.equal(amo.uploads.filter((upload) => upload.submitted).length, 1);
    assert.ok(second.lines.includes(`AMO: version 3.0.0 already exists in the listed channel (id ${version.id}), file status unreviewed. Nothing to upload.`));
    assert.ok(second.lines.includes('AMO cannot show whether version 3.0.0 holds this build. To publish different code, increase version in manifest.json.'));
    assert.ok(second.lines.includes('AMO already holds a source archive for version 3.0.0; the action never replaces it.'));
  });

  it('rides out replica lag on the version after a lost create answer, without a second create', async () => {
    amo.fault('version:create', { drop: 'after', then: () => amo.stale('version', 2) });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(CREATE), 1);
    assert.deepEqual(calls().slice(-5), [CREATE, POLL, LOOKUP('1.4.0'), LOOKUP('1.4.0'), LOOKUP('1.4.0')]);
  });

  it('rides out replica lag on the upload after a lost create answer', async () => {
    amo.fault('version:create', { drop: 'after', then: () => amo.stale('upload', 1) });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.deepEqual(calls().slice(-4), [CREATE, POLL, LOOKUP('1.4.0'), POLL]);
    assert.ok(run.lines.includes('AMO created version 1.4.0; its response was lost.'));
  });

  it('stops when AMO reports the upload submitted but never shows the version', async () => {
    amo.fault('version:create', { drop: 'after', then: () => amo.stale('version', 10) });
    const error = await rejection(publish('1.4.0'));
    assert.match(error.message, /^AMO reports upload [0-9a-f]{32} as submitted but has no version 1\.4\.0\. Check the Developer Hub before re-running\.$/);
    assert.equal(count(LOOKUP('1.4.0')), 5);
  });

  it('sends the create once more when AMO shows no version and the upload unused, then stops after a second unclear answer', async () => {
    amo.fault('version:create', { drop: 'before' }, { drop: 'before' });
    const run = publish('1.4.0');
    const error = await rejection(run);
    assert.match(error.message, /^The version was not created, or its state is unknown\. Re-running is safe: the action looks the version up first\.$/);
    assert.equal(count(CREATE), 2);
    assert.equal(amo.versions.length, 0);
    assert.ok(run.lines.some((line) => line.startsWith('AMO has no version 1.4.0 and upload')));
  });

  it('succeeds when the repeated create goes through', async () => {
    amo.fault('version:create', { status: 502, body: '<html>bad gateway</html>' });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(CREATE), 2);
  });

  it('resolves a repeated create refused as already submitted', async () => {
    amo.fault('version:create', { drop: 'before' }, { drop: 'after' }, { status: 400, body: { upload: ['This upload has already been submitted.'] } });
    amo.fault('version:create');
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(CREATE), 2);
    assert.equal(created().version, '1.4.0');
  });

  it('treats a 201 without a readable body as a lost answer', async () => {
    amo.fault('version:create', { notJson: true });
    assert.equal((await publish('1.4.0')).result, 'submitted');
    assert.equal(count(CREATE), 1);
    amo.reset();
    amo.fault('version:create', { mutate: ({ id, ...rest }) => rest });
    assert.equal((await publish('1.4.0')).result, 'submitted');
  });

  it('stops when AMO refuses an upload as already submitted yet shows it unused and no version', async () => {
    amo.fault('version:create', { status: 400, body: { upload: ['This upload has already been submitted.'] } });
    const error = await rejection(publish('1.4.0'));
    assert.match(error.message, /^AMO refused upload [0-9a-f]{32} as already submitted, yet shows it unsubmitted and has no version 1\.4\.0\.$/);
    assert.equal(count(LOOKUP('1.4.0')), 3);
  });

  it('adopts its own upload after a lost upload answer when the snapshot proves it is new', async () => {
    amo.addUpload({ manifestVersion: '0.9', channel: 'listed', submitted: true });
    amo.fault('upload:create', { drop: 'after' });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(UPLOAD), 1);
    assert.deepEqual(calls().slice(4), [LIST(), UPLOAD, LIST(), POLL, CREATE]);
    assert.ok(run.lines.some((line) => /^Adopting upload [0-9a-f]{32}: it is the only upload AMO's list gained since this run read it\.$/.test(line)));
  });

  it('uploads again after a lost upload answer when the pages are unstable', async () => {
    amo.config.pageSize = 1;
    amo.config.unstableList = true;
    amo.addUpload({ manifestVersion: '0.8' });
    amo.addUpload({ manifestVersion: '0.9' });
    amo.fault('upload:create', { drop: 'after' });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(UPLOAD), 2);
    assert.ok(run.lines.includes('Uploading once more.'));
    assert.equal(amo.uploads.filter((upload) => upload.manifestVersion === '1.4.0' && !upload.submitted).length, 1);
  });

  it('uploads again when the second listing shows more than one new upload or a mismatching one', async () => {
    amo.fault('upload:create', { drop: 'after', then: () => amo.addUpload({ manifestVersion: '5.0' }) });
    await publish('1.4.0');
    assert.equal(count(UPLOAD), 2);

    amo.reset();
    amo.fault('upload:create', { status: 502 });
    amo.fault('upload:list', {}, { mutate: (body) => ({ ...body, count: 1, results: [{ ...body.results[0], uuid: 'f'.repeat(32), submitted: true }] }) });
    amo.addUpload({ manifestVersion: '1.4.0', channel: 'unlisted', uuid: 'a'.repeat(32), submitted: true });
    await publish('1.4.0');
    assert.equal(count(UPLOAD), 2);
  });

  it('stops after two lost upload answers without submitting anything', async () => {
    amo.fault('upload:create', { drop: 'after' }, { drop: 'after' });
    amo.config.pageSize = 1;
    amo.config.unstableList = true;
    amo.addUpload({ manifestVersion: '0.8' });
    amo.addUpload({ manifestVersion: '0.9' });
    const error = await rejection(publish('1.4.0'));
    assert.equal(error.message, 'The upload may or may not have reached AMO. Nothing was submitted. Re-running is safe.');
    assert.equal(count(CREATE), 0);
    assert.ok(amo.uploads.every((upload) => !upload.submitted));
  });

  it('warns and skips when another writer created the version between the lookup and the create', async () => {
    amo.fault('version:create', { concurrentWriter: true });
    const run = publish('1.4.0', { releaseNotes: 'Notes.' });
    assert.equal((await run).result, 'skipped');
    assert.ok(run.warnings.includes("Another writer created version 1.4.0; this run's upload was not used."));
    assert.equal(count(CREATE), 1);
    assert.equal(amo.versions.length, 1);
    assert.equal(run.outputs.result, 'skipped');
    const version = created();
    assert.deepEqual(calls().slice(-5), [CREATE, POLL, LOOKUP('1.4.0'), POLL, PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'Notes.' } });
    assert.equal(amo.uploads.filter((upload) => !upload.submitted).length, 1);
  });

  it('stops with the deleted-version hint when the number belongs to a deleted version', async () => {
    seed('1.4.0', { deleted: true });
    const error = await rejection(publish('1.4.0'));
    assert.equal(error.message, 'AMO says version 1.4.0 was used before: Version 1.4.0 was uploaded before and deleted. A version number can never be reused on AMO, even after deletion. Increase version in manifest.json.');
    assert.equal(count(UPLOAD), 1);
  });

  it('stops with the resolution when the version appears in the other channel after a lost answer', async () => {
    amo.fault('version:create', { status: 504, then: () => seed('1.4.0', { channel: 'listed' }) });
    const error = await rejection(publish('1.4.0'));
    assert.match(error.message, /^Version 1\.4\.0 already exists in the listed channel\./);
  });
});

describe('publishToAmo: validation', () => {
  it('polls until the upload is processed, then shows up to 20 warnings as annotations', async () => {
    const warnings = Array.from({ length: 22 }, (_, i) => ({ type: 'warning', message: `Warning ${i}`, id: ['w'], file: i === 0 ? 'dist/popup.js' : '', line: i === 0 ? 12 : null }));
    amo.queueUpload({ polls: 3, messages: [{ type: 'notice', message: 'fyi', id: 'notice' }, ...warnings] });
    const run = publish('1.4.0');
    await run;
    assert.equal(count(POLL), 3);
    assert.deepEqual(run.slept, [2000, 5000, 5000]);
    assert.ok(run.lines.includes('Validation passed with 22 warnings.'));
    assert.equal(run.warnings.length, 20);
    assert.equal(run.warnings[0], 'AMO validation warning: Warning 0 (dist/popup.js line 12)');
    assert.equal(run.warnings[1], 'AMO validation warning: Warning 1');
  });

  it('logs every 30 s while it waits, and gives up without creating when validation never finishes', async () => {
    amo.queueUpload({ polls: 100 });
    const run = publish('1.4.0');
    const error = await rejection(run);
    assert.match(error.message, /^AMO was still validating after \d+ minutes\. The upload stays unsubmitted and AMO deletes it after 15 days\. Re-run this job\.$/);
    assert.equal(count(POLL), 6);
    assert.equal(count(CREATE), 0);
    assert.ok(run.lines.includes('AMO is still validating the upload.'));
  });

  it('prints the validation errors and stops before the create', async () => {
    amo.queueUpload({
      valid: false,
      messages: [
        { type: 'error', message: 'Unsupported manifest key', id: ['manifest', 'key'], file: 'manifest.json', line: 3 },
        { type: 'error', message: 'Broken file', id: 'broken' },
        { type: 'warning', message: 'not shown', id: [] },
      ],
    });
    const error = await rejection(publish('1.4.0'));
    assert.equal(text(error), "AMO's validation refused version 1.4.0.\nmanifest.json:3 Unsupported manifest key\nBroken file");
    assert.equal(count(CREATE), 0);
  });

  it('explains the revocation when AMO found an API secret in the package', async () => {
    amo.queueUpload({ valid: false, messages: [{ type: 'error', message: 'API key detected', id: ['testcases_content', 'api_key_detected'], file: 'config.js' }] });
    const error = await rejection(publish('1.4.0'));
    assert.match(error.details ?? '', /^config\.js API key detected\nAMO found an API secret in the package and revokes that key 2 minutes after validation\./);
  });

  it('prints the validation JSON when it has no message list', async () => {
    amo.queueUpload({ valid: false });
    amo.fault('upload', { mutate: (body) => ({ ...body, validation: { summary: 'bad' } }) });
    const error = await rejection(publish('1.4.0'));
    assert.equal(error.details, '{"summary":"bad"}');
  });

  it('stops on a validator timeout even when AMO marks the upload valid', async () => {
    amo.queueUpload({ messages: [{ type: 'error', message: 'Validation timed out', id: ['validator', 'unexpected_exception', 'validation_timeout'] }] });
    const error = await rejection(publish('1.4.0'));
    assert.equal(error.message, "AMO's validator timed out on this upload, and AMO refuses to create a version from it. Re-run to upload again.");
    assert.equal(count(CREATE), 0);
  });

  it('stops when AMO read another version from the package, or the upload was used by another writer', async () => {
    amo.queueUpload({ version: '9.9.9' });
    assert.equal((await rejection(publish('1.4.0'))).message, 'AMO read version "9.9.9" from the package, the action read 1.4.0.');
    amo.reset();
    amo.fault('upload', { mutate: (body) => ({ ...body, submitted: true }) });
    assert.match((await rejection(publish('1.4.0'))).message, /^Upload [0-9a-f]{32} was submitted by another writer before this run could use it\.$/);
    amo.reset();
    amo.fault('upload', { mutate: (body) => ({ ...body, channel: 'listed' }) });
    assert.match((await rejection(publish('1.4.0'))).message, /with channel = "listed", which this version of the action does not know\./);
  });

  it('counts failed checks and 404s in the first three polls, and stops after three in a row', async () => {
    amo.queueUpload({ polls: 2 });
    amo.fault('upload', { status: 404, body: { detail: 'Not found.' } }, { status: 503 }, {}, { notJson: true });
    assert.equal((await publish('1.4.0')).result, 'submitted');
    assert.equal(count(POLL), 5);

    amo.reset();
    amo.fault('upload', { status: 404 }, { status: 503 }, { notJson: true });
    assert.match((await rejection(publish('1.4.0'))).message, /returned HTTP 200: <html>/);

    amo.reset();
    amo.fault('upload', { status: 500 }, { drop: 'before' }, { status: 429 });
    const error = await rejection(publish('1.4.0'));
    assert.match(error.message, /^GET \/api\/v5\/addons\/upload\/[0-9a-f]{32}\/ returned HTTP 429/);

    amo.reset();
    amo.fault('upload', { status: 502 }, { status: 502 }, { drop: 'before' });
    assert.match((await rejection(publish('1.4.0'))).message, /^GET \/api\/v5\/addons\/upload\/[0-9a-f]{32}\/ failed: /);

    amo.reset();
    amo.queueUpload({ polls: 5 });
    amo.fault('upload', {}, {}, {}, { status: 404, body: { detail: 'Not found.' } });
    assert.match((await rejection(publish('1.4.0'))).message, /returned HTTP 404: Not found\.$/);

    amo.reset();
    amo.fault('upload', { redirect: 'http://127.0.0.1:9/' });
    assert.match((await rejection(publish('1.4.0'))).message, /answered with a redirect \(HTTP 302\)/);
  });
});

describe('publishToAmo: site status', () => {
  it('stops a real run before the add-on read while AMO is read-only, with its notice', async () => {
    amo.config.readOnly = true;
    amo.config.notice = 'Maintenance until 14:00 UTC.';
    const error = await rejection(publish('1.4.0'));
    assert.equal(text(error), 'AMO is read-only for maintenance. Re-run later.\nAMO notice: Maintenance until 14:00 UTC.');
    assert.deepEqual(calls(), [SITE]);
  });

  it('warns on a dry run and keeps reading', async () => {
    amo.config.readOnly = true;
    const run = publish('1.4.0', { dryRun: true });
    assert.equal((await run).result, 'dry-run');
    assert.ok(run.warnings.includes('AMO is read-only for maintenance. A real run would stop here.'));
    assert.deepEqual(calls(), [...PREFLIGHT('1.4.0'), LIST()]);
  });

  it('shows the notice and the submission notice on every run', async () => {
    amo.config.notice = 'Scheduled maintenance tomorrow.';
    amo.config.submitWarning = 'New policies apply from October.';
    const run = publish('1.4.0');
    await run;
    assert.deepEqual(run.warnings.slice(0, 2), ['AMO submission notice: New policies apply from October.', 'AMO notice: Scheduled maintenance tomorrow.']);
  });

  it('continues when read_only is missing or not a boolean', async () => {
    amo.fault('site', { mutate: () => ({ read_only: 'yes' }) });
    assert.equal((await publish('1.4.0')).result, 'submitted');
  });

  it('corrects a runner clock that is behind AMO, so the tokens pass', async () => {
    amo.config.clockSkewSeconds = 120;
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.ok(run.lines.some((line) => /^The runner clock is 12[01] s behind AMO's; JWT times are adjusted\.$/.test(line)));
    assert.ok(amo.requests.slice(1).every((request) => request.verdict === 'ok'));
  });

  it('does not take the clock from a cached answer', async () => {
    amo.config.clockSkewSeconds = 120;
    amo.config.age = '200';
    const error = await rejection(publish('1.4.0'));
    assert.match(text(error), /returned HTTP 401: Signature has expired\.\nThe runner clock differs from AMO's by more than the action corrects\./);
  });

  it('explains an empty 406 from the edge, and retries a failing status twice', async () => {
    amo.fault('site', { status: 406 });
    assert.match(text(await rejection(publish('1.4.0'))), /^GET \/api\/v5\/site\/\?disable_caching=1 returned HTTP 406: \(empty body\)\nAMO refused this runner's network at its edge/);
    amo.reset();
    amo.fault('site', { status: 503 }, { status: 500 }, { status: 502, body: 'upstream' });
    const run = publish('1.4.0');
    assert.match((await rejection(run)).message, /returned HTTP 502: upstream$/);
    assert.deepEqual(run.slept, [5000, 5000]);
    assert.equal(run.lines.filter((line) => line.endsWith('Trying again in 5 s.')).length, 2);
    amo.reset();
    amo.fault('site', { notJson: true });
    assert.match((await rejection(publish('1.4.0'))).message, /returned a response that is not JSON: <html>/);
  });
});

describe('publishToAmo: add-on and author', () => {
  it('stops on an unknown add-on with the update-only hint', async () => {
    amo.addon.guid = 'other@example.com';
    const error = await rejection(publish('1.4.0'));
    assert.match(text(error), /returned HTTP 404: Not found\.\nAMO has no add-on with this ID that this account can see\. The action updates existing add-ons only/);
    assert.deepEqual(calls(), [SITE, ADDON]);
  });

  it('explains a 401 or 403 for a disabled add-on the account does not author', async () => {
    amo.addon.authors.clear();
    amo.addon.status = 'disabled';
    assert.equal((await rejection(publish('1.4.0'))).message, 'Mozilla disabled this add-on.');
    amo.reset();
    amo.addon.authors.clear();
    amo.addon.isDisabled = true;
    assert.equal((await rejection(publish('1.4.0'))).message, 'The add-on is disabled by its developer, and this account is not one of its authors.');
  });

  it('gives the authentication hints for other 401s', async () => {
    const cases: Array<[string, RegExp]> = [
      ['Unknown JWT iss (issuer).', /AMO does not know this API key\. It was revoked or regenerated/],
      ['Invalid API Key.', /AMO does not know this API key/],
      ['Error decoding signature.', /api-secret does not belong to api-key/],
      ['Invalid JWT Token.', /api-secret does not belong to api-key/],
      ['JWT iat (issued at time) is invalid. Make sure your system clock is synchronized with something like TLSNotary.', /The runner clock differs/],
      ['User has not read developer agreement.', /accept the Firefox Add-on Distribution Agreement/],
      ['User account is disabled.', /deleted or disabled/],
      ['JWT exp (expiration) is too long.', /This is a bug in the action; please report it\./],
      ['Something new.', /^[^\n]*Something new\.$/],
    ];
    for (const [detail, hint] of cases) {
      amo.reset();
      amo.fault('addon', { status: 401, body: { detail } });
      assert.match(text(await rejection(publish('1.4.0'))), hint, detail);
    }
  });

  it('answers the mock with the real 401 texts when the credentials are wrong', async () => {
    const wrongSecret = await rejection(publish('1.4.0', { apiSecret: 'f'.repeat(64) }));
    assert.match(text(wrongSecret), /HTTP 401: Error decoding signature\.\napi-secret does not belong to api-key/);
    const unknownKey = await rejection(publish('1.4.0', { apiKey: 'user:999:1' }));
    assert.match(text(unknownKey), /HTTP 401: Unknown JWT iss \(issuer\)\.\nAMO does not know this API key/);
    amo.accounts.get(API_KEY)!.agreed = false;
    assert.match(text(await rejection(publish('1.4.0'))), /User has not read developer agreement/);
  });

  it('stops on a 451 with the regional hint', async () => {
    amo.addon.restricted = true;
    assert.match(text(await rejection(publish('1.4.0'))), /returned HTTP 451: Unavailable for legal reasons\.\nAMO restricts this add-on in the runner's country/);
  });

  for (const channel of ['listed', 'unlisted'] as const) {
    it(`stops on a Mozilla-disabled or deleted add-on (${channel})`, async () => {
      amo.addon.status = 'disabled';
      assert.equal((await rejection(publish('1.4.0', { channel }))).message, 'Mozilla disabled this add-on.');
      amo.reset();
      amo.fault('addon', { mutate: (body) => ({ ...body, status: 'deleted' }) });
      assert.equal((await rejection(publish('1.4.0', { channel }))).message, 'AMO reports this add-on as deleted.');
    });

    it(`handles a rejected listing (${channel})`, async () => {
      amo.addon.status = 'rejected';
      const run = publish('1.4.0', { channel });
      if (channel === 'listed') {
        assert.match((await rejection(run)).message, /^AMO rejected this add-on's listing content and refuses listed versions/);
        assert.deepEqual(calls(), [SITE, ADDON]);
      } else assert.equal((await run).result, 'submitted');
    });

    it(`handles an add-on disabled by its developer (${channel})`, async () => {
      amo.addon.isDisabled = true;
      const run = publish('1.4.0', { channel });
      if (channel === 'listed') {
        assert.equal((await rejection(run)).message, 'Listed versions cannot be submitted while the add-on is disabled. Enable it in the Developer Hub.');
        assert.equal(count(UPLOAD), 0);
      } else {
        assert.equal((await run).result, 'submitted');
        assert.ok(run.warnings.some((line) => line.startsWith('The add-on is disabled by its developer.')));
      }
    });

    it(`continues on a public, nominated or incomplete add-on (${channel})`, async () => {
      for (const status of ['public', 'nominated', 'incomplete']) {
        amo.reset();
        amo.addon.status = status;
        const run = publish('1.4.0', { channel });
        assert.equal((await run).result, 'submitted', status);
        assert.equal(run.lines.some((line) => line.startsWith('AMO lists the add-on as incomplete')), status === 'incomplete' && channel === 'listed');
      }
    });
  }

  it('explains a listed create that AMO refuses for missing license or metadata', async () => {
    amo.addon.status = 'incomplete';
    amo.addon.hasLicense = false;
    assert.match(text(await rejection(publish('1.4.0', { channel: 'listed' }))), /license: This field is required for listed versions\.\nA listed version needs a license, name, summary and categories/);
    amo.reset();
    amo.addon.hasMetadata = false;
    assert.match(text(await rejection(publish('1.4.0', { channel: 'listed' }))), /Add-on metadata is required.*\nA listed version needs a license/);
  });

  it('warns when a listed version is not greater than the public one, then stops on the refusal', async () => {
    seed('2.0.0', { channel: 'listed', fileStatus: 'public' });
    const run = publish('1.5.0', { channel: 'listed' });
    const error = await rejection(run);
    assert.equal(text(error), `${CREATE} returned HTTP 400: version: Version 1.5.0 must be greater than the previous approved version 2.0.0.\nIncrease version in manifest.json.`);
    assert.ok(run.warnings.includes('AMO will likely refuse 1.5.0: a listed version must be greater than the latest signed listed version (2.0.0 is public).'));
    assert.equal(count(UPLOAD), 1);
  });

  it('does not warn for version strings it cannot compare', async () => {
    seed('2.0.0', { channel: 'listed', fileStatus: 'public' });
    const run = publish('3.0.0-beta', { channel: 'listed' });
    await run;
    assert.ok(!run.warnings.some((line) => line.startsWith('AMO will likely refuse')));
  });

  it('stops when the add-on AMO returns has another guid', async () => {
    amo.fault('addon', { mutate: (body) => ({ ...body, guid: 'other@example.com' }) });
    assert.match((await rejection(publish('1.4.0'))).message, /with guid = "other@example\.com", which this version of the action does not know\./);
  });

  it('logs the owner role with the least-privilege advice', async () => {
    amo.addon.authors.set(ACCOUNT, 'owner');
    const run = publish('1.4.0');
    await run;
    assert.ok(run.lines.includes('AMO: add-on my-extension@example.com is public, and this account is an owner of it. An account with the developer role cannot delete the add-on or change its authors; see the README.'));
  });

  it('stops before any upload when the account is not an author', async () => {
    const other = amo.addAccount({ id: 777, key: 'user:777:1', secret: 's'.repeat(64) });
    const run = publish('1.4.0', { apiKey: other.key, apiSecret: other.secret });
    assert.match(text(await rejection(run)), /authors\/777\/ returned HTTP 403: You do not have permission to perform this action\.\nThe account behind api-key is not an author of this add-on/);
    assert.deepEqual(calls(), [SITE, ADDON, 'GET /api/v5/addons/addon/1234/authors/777/']);
    amo.reset();
    amo.fault('author', { status: 404, body: { detail: 'Not found.' } });
    assert.match(text(await rejection(publish('1.4.0'))), /The account behind api-key is not an author/);
    amo.reset();
    amo.fault('author', { status: 500 }, { status: 500 }, { status: 500 });
    assert.match((await rejection(publish('1.4.0'))).message, /authors\/12345\/ returned HTTP 500/);
  });

  it('shows a restriction 403 on the upload verbatim', async () => {
    amo.fault('upload:create', { status: 403, body: { detail: 'Your account is restricted from submitting add-ons.', code: 'permission_denied_restriction' } });
    const error = await rejection(publish('1.4.0'));
    assert.equal(text(error), `${UPLOAD} returned HTTP 403: Your account is restricted from submitting add-ons. (permission_denied_restriction)\nAMO restricts submissions from this account or network.`);
  });
});

describe('publishToAmo: existing versions', () => {
  it('skips an unreviewed version in this channel without uploading', async () => {
    const version = seed('1.4.0');
    const run = publish('1.4.0');
    assert.deepEqual(await run, { result: 'skipped', state: 'unreviewed', versionId: version.id });
    assert.deepEqual(calls(), PREFLIGHT('1.4.0'));
    assert.equal(run.outputs['version-id'], String(version.id));
    assert.ok(run.lines.includes(`AMO: version 1.4.0 already exists in the unlisted channel (id ${version.id}), file status unreviewed. Nothing to upload.`));
  });

  it('treats a version that differs only in letter case as the same', async () => {
    seed('1.4.0-Beta');
    const run = publish('1.4.0-beta');
    assert.equal((await run).result, 'skipped');
    assert.ok(run.lines.includes('AMO stores this version as 1.4.0-Beta.'));
  });

  it('stops before uploading when the version exists in the other channel', async () => {
    seed('1.4.0', { channel: 'unlisted' });
    const error = await rejection(publish('1.4.0', { channel: 'listed' }));
    assert.equal(error.message, 'Version 1.4.0 already exists in the unlisted channel. AMO allows each version number once across channels; increase version in manifest.json.');
    assert.deepEqual(calls(), PREFLIGHT('1.4.0'));
    amo.reset();
    seed('1.4.0', { channel: 'enterprise' });
    assert.match((await rejection(publish('1.4.0'))).message, /already exists in the enterprise channel/);
  });

  it('stops on a version disabled by a developer, rejected by AMO, or disabled by a newer listed version', async () => {
    seed('1.4.0', { isDisabled: true });
    const disabled = publish('1.4.0');
    assert.equal((await rejection(disabled)).message, 'Version 1.4.0 was disabled by a developer of the add-on. Re-enable it in the Developer Hub, or release a new version.');
    assert.equal(disabled.outputs.state, 'unreviewed');
    amo.reset();
    seed('1.4.0', { fileStatus: 'disabled' });
    const rejected = publish('1.4.0');
    const error = await rejection(rejected);
    assert.equal(error.message, 'AMO rejected or disabled version 1.4.0. Release a new version.');
    assert.equal(error.details, undefined);
    assert.equal(rejected.outputs.state, 'disabled');
    amo.reset();
    await publish('1.4.0', { channel: 'listed' });
    await publish('1.5.0', { channel: 'listed', zip: addonZip('1.5.0') });
    const older = await rejection(publish('1.4.0', { channel: 'listed' }));
    assert.match(older.details ?? '', /Creating a newer listed version also disables an older listed version that is still awaiting review\./);
  });

  it('downloads the signed file of an existing public unlisted version without uploading', async () => {
    const version = seed('1.4.0', { fileStatus: 'public' });
    const target = join(dir, 'existing', 'signed.xpi');
    const run = publish('1.4.0', { signedXpi: target });
    assert.deepEqual(await run, { result: 'skipped', state: 'public', versionId: version.id, signedXpi: target });
    assert.deepEqual(calls(), [...PREFLIGHT('1.4.0'), `GET /firefox/downloads/file/${version.fileId}/my-extension-1.4.0.xpi`]);
    assert.deepEqual(readFileSync(target), version.bytes);
    assert.equal(run.outputs['signed-xpi'], target);
    assert.equal(amo.requests.at(-1)!.verdict, 'ok');
    assert.deepEqual(
      readdirSync(join(dir, 'existing')).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('does not set edit-url when AMO points it at another host', async () => {
    seed('1.4.0');
    amo.fault('version', { mutate: (body) => ({ ...body, edit_url: 'https://evil.example/versions/1' }) });
    const run = publish('1.4.0');
    await run;
    assert.equal(run.outputs['edit-url'], undefined);
    amo.reset();
    seed('1.4.0');
    amo.fault('version', { mutate: (body) => ({ ...body, edit_url: 'not a url' }) });
    const broken = publish('1.4.0');
    await broken;
    assert.equal(broken.outputs['edit-url'], undefined);
  });
});

describe('publishToAmo: upload and create refusals', () => {
  it('stops with AMO field messages on a 400 upload', async () => {
    amo.fault('upload:create', { status: 400, body: { detail: 'Missing "upload" key in multipart file data.' } });
    assert.equal((await rejection(publish('1.4.0'))).message, `${UPLOAD} returned HTTP 400: Missing "upload" key in multipart file data.`);
    amo.reset();
    const error = await rejection(publish('1.4.0', { zipName: 'extension.ZIP' }));
    assert.equal(error.message, `${UPLOAD} returned HTTP 400: upload: Unsupported file type, please upload a supported file (.crx, .xpi, .zip).`);
  });

  it('stops without recovery on 401, 406, 413, 451 and a 503 with a JSON error', async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [401, { detail: 'Signature has expired.' }, /Signature has expired\.\nThe runner clock differs/],
      [406, undefined, /AMO refused this runner's network at its edge/],
      [413, 'Request Entity Too Large', /HTTP 413: Request Entity Too Large\nThe package is larger than AMO accepts\./],
      [451, { detail: 'Unavailable.' }, /AMO restricts this add-on in the runner's country/],
      [503, { error: 'Add-on uploads are temporarily unavailable.', reason: 'Scheduled work.' }, /HTTP 503: Add-on uploads are temporarily unavailable\. Scheduled work\.\nAMO is read-only for maintenance, or has paused submissions\. Re-running is safe/],
    ];
    for (const [status, body, pattern] of cases) {
      amo.reset();
      amo.fault('upload:create', { status, body });
      assert.match(text(await rejection(publish('1.4.0'))), pattern, String(status));
      assert.equal(count(UPLOAD), 1, String(status));
    }
  });

  it('waits for Retry-After on a throttled write, at most twice per run', async () => {
    amo.config.throttle = { uploads: 0, submissions: 10, retryAfter: '30' };
    const run = publish('1.4.0');
    const error = await rejection(run);
    assert.match(text(error), /HTTP 429: Request was throttled\.\nAMO throttled this account: at most 6 uploads per minute, .* Try again after 1 minutes\./);
    assert.equal(count(UPLOAD), 3);
    assert.equal(run.slept.filter((ms) => ms === 30_000).length, 2);
    assert.ok(run.lines.includes(`AMO throttled ${UPLOAD}; waiting 30 s as its Retry-After header asks.`));
  });

  it('retries a throttled create and PATCH, and stops at once on a Retry-After above 120 s', async () => {
    amo.fault('version:create', { status: 429, headers: { 'Retry-After': '5' } });
    assert.equal((await publish('1.4.0')).result, 'submitted');
    assert.equal(count(CREATE), 2);
    amo.reset();
    amo.fault('upload:create', { status: 429, headers: { 'Retry-After': new Date(Date.now() + 3_600_000).toUTCString() } });
    assert.match(text(await rejection(publish('1.4.0'))), /Try again after 60 minutes\.$/);
    amo.reset();
    amo.fault('upload:create', { status: 429 });
    assert.match(text(await rejection(publish('1.4.0'))), /Try again after a few minutes\.$/);
  });

  it('waits for Retry-After on a throttled read and counts it as a failed try', async () => {
    amo.fault('addon', { status: 429, headers: { 'Retry-After': '2' } }, { status: 429, headers: { 'Retry-After': '2' } }, { status: 429, headers: { 'Retry-After': '2' } });
    const run = publish('1.4.0');
    assert.match(text(await rejection(run)), /HTTP 429.*\nAMO throttled this account/);
    assert.deepEqual(run.slept, [2000, 2000]);
  });

  it('stops on a create refused for an invalid upload, a source problem, the add-on ID or another field', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ upload: ['Upload is not valid.'] }, /HTTP 400: upload: Upload is not valid\.\nThe upload failed validation, or AMO's validator timed out on it/],
      [{ source: ['Invalid or broken archive.'] }, /HTTP 400: source: Invalid or broken archive\.$/],
      [{ non_field_errors: ['The add-on ID in your manifest.json (a@b) does not match the ID of your add-on on AMO (c@d)'] }, /HTTP 400: The add-on ID in your manifest\.json/],
      [{ non_field_errors: ['Listed versions cannot be submitted while add-on is disabled.'] }, /HTTP 400: Listed versions cannot be submitted while add-on is disabled\.$/],
      [{ compatibility: { firefox: ['Invalid version.'] } }, /HTTP 400: compatibility: firefox: Invalid version\.$/],
      [{ license: ['Unknown license.'] }, /HTTP 400: license: Unknown license\.$/],
    ];
    for (const [body, pattern] of cases) {
      amo.reset();
      amo.fault('version:create', { status: 400, body });
      assert.match(text(await rejection(publish('1.4.0'))), pattern);
    }
    amo.reset();
    amo.fault('version:create', { status: 403, body: { detail: 'You do not have permission to perform this action.' } });
    assert.match(text(await rejection(publish('1.4.0'))), /\nThe account behind api-key is not an author/);
    amo.reset();
    amo.fault('version:create', { status: 409, body: { detail: 'Conflict.' } });
    assert.match((await rejection(publish('1.4.0'))).message, /HTTP 409: Conflict\.$/);
    amo.reset();
    amo.fault('version:create', { status: 503, body: { error: 'Site in read-only mode.' } });
    assert.match(text(await rejection(publish('1.4.0'))), /HTTP 503: Site in read-only mode\.\nAMO is read-only for maintenance/);
  });

  it('lets the mock refuse a broken source archive and a source with the wrong extension', async () => {
    const broken = Buffer.from(sourceZip());
    broken[30 + 'package.json'.length + 4] = broken[30 + 'package.json'.length + 4]! ^ 0xff;
    assert.match((await rejection(publish('1.4.0', { source: broken }))).message, /source: Invalid or broken archive\./);
    amo.reset();
    assert.match((await rejection(publish('1.4.0', { source: sourceZip(), sourceName: 'source.rar' }))).message, /source: Unsupported file type/);
  });

  it('stops when the create or the upload answers with another version or channel', async () => {
    amo.fault('version:create', { mutate: (body) => ({ ...body, version: '1.4.1' }) });
    assert.match((await rejection(publish('1.4.0'))).message, /^AMO answered POST \/api\/v5\/addons\/addon\/1234\/versions\/ with version = "1\.4\.1"/);
    amo.reset();
    amo.fault('version:create', { mutate: (body) => ({ ...body, channel: 'listed' }) });
    const error = await rejection(publish('1.4.0'));
    assert.match(text(error), /with channel = "listed", which this version of the action does not know\.\nThe v5 API may have changed\. The package was uploaded to AMO, but no version was created\./);
    amo.reset();
    amo.fault('upload:create', { mutate: (body) => ({ ...body, channel: 'listed' }) });
    assert.match(text(await rejection(publish('1.4.0'))), /with channel = "listed".*\nThe v5 API may have changed\. Nothing was uploaded\./s);
    amo.reset();
    amo.fault('upload:create', { mutate: (body) => ({ ...body, uuid: '../../etc' }) });
    assert.match((await rejection(publish('1.4.0'))).message, /with uuid = "\.\.\/\.\.\/etc"/);
  });
});

describe('publishToAmo: completing a version', () => {
  it('sends nothing when the notes are already there, ignoring line endings and surrounding space', async () => {
    seed('1.4.0', { releaseNotes: { 'en-US': 'Line one\r\nLine two' }, approvalNotes: 'Build it.' });
    const run = publish('1.4.0', { releaseNotes: '  Line one\nLine two\n', approvalNotes: 'Build it.' });
    assert.equal((await run).result, 'skipped');
    assert.deepEqual(writes(), []);
    assert.deepEqual(run.warnings, []);
  });

  it('fills missing release notes and approval notes in one JSON PATCH', async () => {
    const version = seed('1.4.0', { releaseNotes: { 'en-US': '' } });
    const run = publish('1.4.0', { releaseNotes: 'Notes.', approvalNotes: 'Build it.' });
    await run;
    assert.deepEqual(writes(), [PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'Notes.' }, approval_notes: 'Build it.' });
    assert.ok(run.lines.includes('Set the release notes and approval notes.'));
  });

  it('leaves different notes on an existing version with a warning', async () => {
    seed('1.4.0', { releaseNotes: { 'en-US': 'Edited by hand.' }, approvalNotes: 'Old steps.' });
    const run = publish('1.4.0', { releaseNotes: 'Notes.', approvalNotes: 'Build it.' });
    await run;
    assert.deepEqual(writes(), []);
    assert.deepEqual(run.warnings, [
      'Version 1.4.0 has other approval notes on AMO. The action leaves them; edit them in the Developer Hub.',
      'Version 1.4.0 has other release notes on AMO. The action leaves them; edit them in the Developer Hub.',
    ]);
  });

  it('sends no approval notes to an approved version, and fills its release notes', async () => {
    const version = seed('1.4.0', { fileStatus: 'public' });
    const run = publish('1.4.0', { releaseNotes: 'Notes.', approvalNotes: 'Build it.' });
    await run;
    assert.deepEqual(writes(), [PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { release_notes: { 'en-US': 'Notes.' } });
    assert.ok(run.lines.includes('Version 1.4.0 is already approved, so the approval notes are not sent: review is over.'));
    amo.reset();
    seed('1.4.0', { fileStatus: 'public', approvalNotes: 'Other.' });
    const other = publish('1.4.0', { approvalNotes: 'Build it.' });
    await other;
    assert.deepEqual(other.warnings, []);
  });

  it('adds missing source to an unreviewed version in a multipart PATCH, with missing approval notes', async () => {
    const version = seed('1.4.0');
    const run = publish('1.4.0', { source: sourceZip(), approvalNotes: 'Build it.', releaseNotes: 'Notes.' });
    await run;
    assert.deepEqual(writes(), [PATCH(version.id), PATCH(version.id)]);
    const [multipart, json] = amo.requests.slice(-2);
    assert.deepEqual(Object.keys(multipart!.form!).sort(), ['approval_notes', 'source']);
    assert.deepEqual(json!.json, { release_notes: { 'en-US': 'Notes.' } });
    assert.ok(run.lines.includes('Added the source ZIP and the approval notes.'));
  });

  it('keeps the approval notes for the JSON PATCH when the multipart PATCH did not store them', async () => {
    const version = seed('1.4.0');
    amo.fault('version:patch', { mutate: (body) => ({ ...body, approval_notes: '' }) });
    await publish('1.4.0', { source: sourceZip(), approvalNotes: 'Build it.' });
    assert.deepEqual(writes(), [PATCH(version.id), PATCH(version.id)]);
    assert.deepEqual(amo.requests.at(-1)!.json, { approval_notes: 'Build it.' });
  });

  it('warns instead of adding source to an approved version, and never replaces existing source', async () => {
    seed('1.4.0', { fileStatus: 'public' });
    const run = publish('1.4.0', { source: sourceZip() });
    await run;
    assert.deepEqual(writes(), []);
    assert.match(run.warnings[0] ?? '', /^Version 1\.4\.0 is already approved without source code\. AMO refuses a source change after a human review/);
    amo.reset();
    seed('1.4.0', { source: 'https://addons.mozilla.org/source/1.zip' });
    const existing = publish('1.4.0', { source: sourceZip() });
    await existing;
    assert.deepEqual(writes(), []);
    assert.ok(existing.lines.includes('AMO already holds a source archive for version 1.4.0; the action never replaces it.'));
  });

  it('stops with AMO message when the source PATCH is refused after a human review', async () => {
    seed('1.4.0', { humanReviewed: true });
    const error = await rejection(publish('1.4.0', { source: sourceZip() }));
    assert.match(error.message, /HTTP 400: source: Source cannot be changed because this version has been reviewed by Mozilla\.$/);
  });

  it('stops with an unknown state when the source field is missing and a source ZIP is given', async () => {
    seed('1.4.0');
    amo.fault('version', { mutate: ({ source, ...rest }) => rest });
    assert.match((await rejection(publish('1.4.0', { source: sourceZip() }))).message, /with source = missing, which this version of the action does not know\./);
    amo.reset();
    seed('1.4.0');
    amo.fault('version', { mutate: ({ source, ...rest }) => rest });
    assert.equal((await publish('1.4.0')).result, 'skipped');
  });

  it('keeps result set when the notes PATCH fails after a create, and a re-run completes it', async () => {
    amo.fault('version:patch', { status: 503, body: { error: 'Site in read-only mode.' } });
    const first = publish('2.0.0', { source: sourceZip(), releaseNotes: 'Notes.' });
    assert.match(text(await rejection(first)), /PATCH .* returned HTTP 503: Site in read-only mode\.\nAMO is read-only for maintenance, or has paused submissions\. Re-running is safe/);
    assert.equal(first.outputs.result, 'submitted');
    assert.equal(first.outputs['version-id'], String(created().id));
    const second = publish('2.0.0', { source: sourceZip(), releaseNotes: 'Notes.' });
    assert.equal((await second).result, 'skipped');
    assert.deepEqual(created().releaseNotes, { 'en-US': 'Notes.' });
  });

  it('reads the version again after an unclear PATCH and repeats it only when the field is still missing', async () => {
    const version = seed('1.4.0');
    amo.fault('version:patch', { drop: 'after' });
    const run = publish('1.4.0', { releaseNotes: 'Notes.' });
    await run;
    assert.deepEqual(calls().slice(-2), [PATCH(version.id), VERSION(version.id)]);
    assert.ok(run.lines.some((line) => line.startsWith('Setting the release notes gave no clear answer')));

    amo.reset();
    const again = seed('1.4.0');
    amo.fault('version:patch', { drop: 'before' }, { status: 502 });
    const error = await rejection(publish('1.4.0', { releaseNotes: 'Notes.' }));
    assert.match(text(error), /^Setting the release notes on version 1\.4\.0 failed: PATCH .* returned HTTP 502: \(empty body\)\nRe-running is safe/);
    assert.deepEqual(calls().slice(-3), [PATCH(again.id), VERSION(again.id), PATCH(again.id)]);

    amo.reset();
    seed('1.4.0');
    amo.fault('version:patch', { status: 400, body: { release_notes: { 'en-US': ['Too long.'] } } });
    assert.match((await rejection(publish('1.4.0', { releaseNotes: 'Notes.' }))).message, /HTTP 400: release_notes: en-US: Too long\.$/);

    amo.reset();
    const stored = seed('1.4.0');
    amo.fault('version:patch', { notJson: true });
    await publish('1.4.0', { releaseNotes: 'Notes.' });
    assert.deepEqual(calls().slice(-2), [PATCH(stored.id), VERSION(stored.id)]);

    amo.reset();
    seed('1.4.0');
    amo.fault('version:patch', { drop: 'before', then: () => amo.fault('version', { status: 500 }, { status: 500 }, { status: 500 }) });
    assert.match((await rejection(publish('1.4.0', { releaseNotes: 'Notes.' }))).message, /versions\/\d+\/ returned HTTP 500/);
  });

  it('reports the PATCHes a dry run would send', async () => {
    const version = seed('1.4.0');
    const run = publish('1.4.0', { dryRun: true, source: sourceZip(), releaseNotes: 'Notes.', approvalNotes: 'Build it.' });
    assert.equal((await run).result, 'skipped');
    assert.deepEqual(writes(), []);
    assert.ok(run.lines.includes(`Dry run: a real run would send PATCH /api/v5/addons/addon/1234/versions/${version.id}/ with the source ZIP and the approval notes.`));
    assert.ok(run.lines.includes(`Dry run: a real run would send PATCH /api/v5/addons/addon/1234/versions/${version.id}/ with the release notes.`));
    amo.reset();
    const plain = seed('1.4.0');
    const notes = publish('1.4.0', { dryRun: true, approvalNotes: 'Build it.', wait: true });
    await notes;
    assert.ok(notes.lines.includes(`Dry run: a real run would send PATCH /api/v5/addons/addon/1234/versions/${plain.id}/ with the approval notes.`));
    assert.ok(notes.lines.includes('Dry run: a real run would wait up to 15 minutes for AMO to sign version 1.4.0.'));
  });
});

describe('publishToAmo: waiting and downloading', () => {
  it('waits for signing, then downloads and verifies the signed file', async () => {
    amo.config.signAfterReads = 3;
    const target = join(dir, 'wait', 'signed.xpi');
    const run = publish('1.4.0', { signedXpi: target, waitTimeoutMinutes: 2 });
    const result = await run;
    const version = created();
    assert.deepEqual(result, { result: 'submitted', state: 'public', versionId: version.id, signedXpi: target });
    assert.deepEqual(calls().slice(-4), [VERSION(version.id), VERSION(version.id), VERSION(version.id), `GET /firefox/downloads/file/${version.fileId}/my-extension-1.4.0.xpi`]);
    assert.deepEqual(readFileSync(target), version.bytes);
    assert.deepEqual(run.outputs, { result: 'submitted', state: 'public', 'version-id': String(version.id), 'edit-url': `${amo.base}/en-US/developers/addon/my-extension/versions/${version.id}`, 'signed-xpi': target });
    assert.ok(run.lines.includes('Waiting up to 2 minutes for AMO to sign version 1.4.0.'));
    assert.ok(run.lines.includes('AMO signed version 1.4.0.'));
    assert.deepEqual(run.slept.filter((ms) => ms === 15_000).length, 2);
  });

  it('fails with state unreviewed after the wait timeout, and a re-run downloads once signed', async () => {
    const options = { wait: true, waitTimeoutMinutes: 2 };
    const first = publish('1.4.0', options);
    const error = await rejection(first);
    assert.equal(error.message, 'Version 1.4.0 is still unreviewed after 2 minutes. It stays submitted; re-run this job later to wait again and download it, or raise wait-timeout.');
    assert.equal(first.outputs.state, 'unreviewed');
    assert.equal(first.outputs.result, 'submitted');
    assert.equal(count(VERSION(created().id)), 8);
    assert.ok(first.lines.includes('Version 1.4.0 is still unreviewed.'));

    amo.sign(created());
    const target = join(dir, 'rerun.xpi');
    const second = publish('1.4.0', { signedXpi: target });
    assert.deepEqual(await second, { result: 'skipped', state: 'public', versionId: created().id, signedXpi: target });
    assert.ok(existsSync(target));
  });

  it('adds the listed review note to a listed timeout', async () => {
    const error = await rejection(publish('1.4.0', { channel: 'listed', wait: true, waitTimeoutMinutes: 1 }));
    assert.match(error.details ?? '', /^Mozilla reviews listed versions; signing can take 24 hours or longer/);
  });

  it('stops when AMO rejects the version, or a developer disables it, while the action waits', async () => {
    amo.config.rejectAfterReads = 2;
    const run = publish('1.4.0', { wait: true });
    assert.equal((await rejection(run)).message, 'AMO rejected or disabled version 1.4.0 while the action waited.');
    assert.equal(run.outputs.state, 'disabled');
    amo.reset();
    amo.fault('version', {}, { mutate: (body) => ({ ...body, is_disabled: true }) });
    assert.equal((await rejection(publish('1.4.0', { wait: true }))).message, 'A developer of the add-on disabled version 1.4.0 while the action waited.');
  });

  it('counts failed checks while waiting, and stops after three in a row', async () => {
    amo.config.signAfterReads = 3;
    amo.fault('version', {}, { status: 503 }, { notJson: true }, {}, { drop: 'before' }, {});
    assert.equal((await publish('1.4.0', { wait: true })).state, 'public');
    amo.reset();
    amo.fault('version', {}, { status: 503 }, { status: 504 }, { status: 429 });
    assert.match((await rejection(publish('1.4.0', { wait: true }))).message, /returned HTTP 429/);
    amo.reset();
    amo.fault('version', {}, { drop: 'before' }, { drop: 'before' }, { drop: 'before' });
    assert.match((await rejection(publish('1.4.0', { wait: true }))).message, /failed: /);
    amo.reset();
    amo.fault('version', {}, { status: 404, body: { detail: 'Not found.' } });
    assert.match((await rejection(publish('1.4.0', { wait: true }))).message, /returned HTTP 404/);
  });

  it('does not wait for a version that is already public, and reports a dry run download', async () => {
    seed('1.4.0', { fileStatus: 'public' });
    const run = publish('1.4.0', { wait: true, dryRun: true, signedXpi: join(dir, 'dry.xpi') });
    assert.equal((await run).result, 'skipped');
    assert.deepEqual(calls(), PREFLIGHT('1.4.0'));
    assert.ok(run.lines.includes(`Dry run: a real run would download the signed file to ${join(dir, 'dry.xpi')}.`));
    assert.ok(!existsSync(join(dir, 'dry.xpi')));
  });
});

describe('publishToAmo: dry run and unknown states', () => {
  it('reads everything a real run reads for a new version and writes nothing', async () => {
    const run = publish('1.4.0', { dryRun: true, source: sourceZip(), releaseNotes: 'Notes.', approvalNotes: 'Build it.' });
    assert.deepEqual(await run, { result: 'dry-run', state: '' });
    assert.deepEqual(calls(), [...PREFLIGHT('1.4.0'), LIST()]);
    assert.deepEqual(run.outputs, { result: 'dry-run', state: '' });
    assert.ok(run.lines.includes('Dry run: version 1.4.0 would be uploaded to the unlisted channel and created with the source ZIP, release notes, approval notes. Nothing was sent to AMO.'));
    amo.reset();
    const bare = publish('1.4.0', { dryRun: true });
    await bare;
    assert.ok(bare.lines.includes('Dry run: version 1.4.0 would be uploaded to the unlisted channel and created. Nothing was sent to AMO.'));
  });

  it('stops with the does-not-know message on unknown values and missing fields', async () => {
    const cases: Array<[Parameters<MockAmo['fault']>[0], (body: any) => unknown, RegExp, boolean?]> = [
      ['addon', (body) => ({ ...body, status: 'archived' }), /with status = "archived"/],
      ['addon', ({ id, ...rest }) => rest, /with id = missing/],
      ['addon', ({ guid, ...rest }) => rest, /with guid = missing/],
      ['addon', (body) => ({ ...body, is_disabled: 'no' }), /with is_disabled = "no"/],
      ['author', (body) => ({ ...body, role: 'translator' }), /with role = "translator"/],
      ['version', (body) => ({ ...body, file: { ...body.file, status: 'nominated' } }), /with file\.status = "nominated"/, true],
      ['version', (body) => ({ ...body, channel: 'beta' }), /with channel = "beta"/, true],
      ['version', ({ file, ...rest }) => rest, /with file = missing/, true],
      ['version', (body) => ({ ...body, version: '9.9.9' }), /with version = "9\.9\.9"/, true],
      ['version', (body) => ({ ...body, id: -1 }), /with id = -1/, true],
      ['upload', (body) => ({ ...body, processed: 'yes' }), /with processed = "yes"/],
    ];
    for (const [route, mutate, pattern, existing] of cases) {
      amo.reset();
      if (existing) seed('1.4.0');
      amo.fault(route, { mutate });
      const error = await rejection(publish('1.4.0'));
      assert.match(error.message, pattern);
      assert.match(error.message, /which this version of the action does not know\.$/);
      assert.match(error.details ?? '', /^The v5 API may have changed\./);
    }
  });

  it('cuts a long unknown value at 200 characters', async () => {
    amo.fault('addon', { mutate: (body) => ({ ...body, status: 'x'.repeat(500) }) });
    const error = await rejection(publish('1.4.0'));
    assert.ok(error.message.length < 400);
    assert.match(error.message, /x\.\.\., which/);
  });

  it('ignores extra fields everywhere', async () => {
    const extra = (body: any) => ({ ...body, brand_new_field: { nested: [1, 2, 3] } });
    for (const route of ['site', 'addon', 'author', 'upload:create', 'upload', 'upload:list', 'version:create'] as const) amo.fault(route, { mutate: extra });
    assert.equal((await publish('1.4.0', { releaseNotes: 'Notes.' })).result, 'submitted');
  });

  it('encodes IDs with braces and versions with a plus sign in paths', async () => {
    const guid = '{12345678-abcd-4ef0-9123-456789abcdef}';
    amo.addon.guid = guid;
    const run = publish('1.0.0+build.7', { addonId: guid, zip: addonZip('1.0.0+build.7', { id: guid }) });
    assert.equal((await run).result, 'submitted');
    assert.equal(calls()[1], `GET /api/v5/addons/addon/%7B12345678-abcd-4ef0-9123-456789abcdef%7D/`);
    assert.equal(calls()[3], 'GET /api/v5/addons/addon/1234/versions/v1.0.0%2Bbuild.7/');
  });

  it('refuses to follow a redirect on a write, so the token stays with AMO', async () => {
    const other = await startMockStore();
    try {
      amo.fault('version:create', { redirect: `${other.base}/stolen` });
      assert.match((await rejection(publish('1.4.0'))).message, /POST \/api\/v5\/addons\/addon\/1234\/versions\/ answered with a redirect \(HTTP 302\), which the action refuses to follow\./);
      assert.equal(other.requests.length, 0);
    } finally {
      await other.close();
    }
  });
});

describe('publishToAmo: more faults', () => {
  it('recovers from an upload answer that breaks off, after a slow site answer', async () => {
    amo.fault('site', { delayMs: 20 });
    amo.fault('upload:create', { partial: true });
    const run = publish('1.4.0');
    assert.equal((await run).result, 'submitted');
    assert.equal(count(UPLOAD), 1);
    assert.ok(run.lines.some((line) => /^The answer to the upload was lost \(POST \/api\/v5\/addons\/upload\/ returned HTTP 201, then failed while reading the response/.test(line)));
  });

  it('does not wrap an unknown state found while resolving a lost create', async () => {
    amo.fault('version:create', { drop: 'after', then: () => amo.fault('upload', { mutate: (body) => ({ ...body, submitted: 'maybe' }) }) });
    assert.match((await rejection(publish('1.4.0'))).message, /^AMO answered GET \/api\/v5\/addons\/upload\/[0-9a-f]{32}\/ with submitted = "maybe"/);
  });

  it('refuses a signed file URL on another host, and corrupted bytes, leaving no file', async () => {
    seed('1.4.0', { fileStatus: 'public' });
    amo.fault('version', { mutate: (body) => ({ ...body, file: { ...body.file, url: 'https://addons.cdn.mozilla.net/file.xpi' } }) });
    const target = join(dir, 'foreign.xpi');
    assert.match((await rejection(publish('1.4.0', { signedXpi: target }))).message, /^AMO returned a download URL on addons\.cdn\.mozilla\.net\. The action sends the JWT to 127\.0\.0\.1:\d+ only\.$/);
    assert.ok(!calls().some((call) => call.includes('/downloads/')));
    amo.reset();
    const version = seed('1.4.0', { fileStatus: 'public' });
    const corrupted = Buffer.from(version.bytes);
    corrupted[20] = corrupted[20]! ^ 0xff;
    amo.fault('download', { status: 200, bytes: corrupted });
    assert.match((await rejection(publish('1.4.0', { signedXpi: target }))).message, /^The downloaded file has SHA-256 [0-9a-f]{64}, but AMO reported/);
    assert.equal(existsSync(target), false);
  });

  it('refuses the download of an unlisted file for an account that is not an author', async () => {
    seed('1.4.0', { fileStatus: 'public' });
    amo.fault('download', { then: () => amo.addon.authors.delete(ACCOUNT) });
    const error = await rejection(publish('1.4.0', { signedXpi: join(dir, 'nope.xpi') }));
    assert.match(text(error), /returned HTTP 404: Not found\.\nAMO refused the signed file\. Only an author of the add-on can download an unlisted file/);
  });

  it('warns for a listed version equal to the public one in Mozilla order', async () => {
    seed('2.0.0', { channel: 'listed', fileStatus: 'public' });
    const run = publish('2.0', { channel: 'listed' });
    await rejection(run);
    assert.ok(run.warnings.includes('AMO will likely refuse 2.0: a listed version must be greater than the latest signed listed version (2.0.0 is public).'));
  });
});
