import { AMO_BASE, type AmoClient, amoClient, AmoError, ambiguousStatus, AUTHOR_HINT, definiteUnavailable, type Reply, type Request, sleepFor } from './client.ts';
import { type Compatibility, compatibilityMatches, describeCompatibility } from './compatibility.ts';
import {
  type Addon,
  decodeAddon,
  decodeRole,
  decodeUpload,
  decodeUploadItem,
  decodeUploadPage,
  decodeVersion,
  fieldMessages,
  isObject,
  isValidationTimeout,
  logSafe,
  unknownState,
  type Upload,
  type UploadItem,
  type ValidationMessage,
  validationMessages,
  type Version,
  type Where,
} from './decode.ts';
import { downloadSignedFile } from './download.ts';
import { ActionError } from './errors.ts';
import { clockOffsetFrom } from './jwt.ts';

export type OutputName = 'result' | 'state' | 'version-id' | 'edit-url' | 'signed-xpi';

export interface Timing {
  retryDelayMs: number;
  validationFirstMs: number;
  validationIntervalMs: number;
  validationChecks: number;
  waitIntervalMs: number;
  resolutionDelayMs: number;
}

export interface PublishOptions {
  apiKey: string;
  apiSecret: string;
  addonId: string;
  version: string;
  channel: 'listed' | 'unlisted';
  zip: Buffer;
  zipName: string;
  source?: Buffer;
  sourceName?: string;
  releaseNotes?: string;
  approvalNotes?: string;
  compatibility?: Compatibility;
  wait?: boolean;
  waitTimeoutMinutes?: number;
  signedXpi?: string;
  dryRun?: boolean;
  apiBase?: string;
  timing?: Partial<Timing>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  mask?: (value: string) => void;
  output?: (name: OutputName, value: string) => void;
}

export interface PublishResult {
  result: 'submitted' | 'skipped' | 'dry-run';
  state: string;
  versionId?: number;
  signedXpi?: string;
}

export const DEFAULT_TIMING: Timing = {
  retryDelayMs: 5_000,
  validationFirstMs: 2_000,
  validationIntervalMs: 5_000,
  validationChecks: 120,
  waitIntervalMs: 15_000,
  resolutionDelayMs: 5_000,
};

const UPLOAD_PATH = '/api/v5/addons/upload/';
const POLL_FAILURES = new Set([429, 500, 502, 503, 504]);
const UUID = /^[0-9a-f]{32}$/;
const RERUN_SAFE = 'Re-running is safe: the action looks the version up first.';
const UPLOADED = 'The package was uploaded to AMO, but no version was created.';
const UPDATE_ONLY_HINT = 'AMO has no add-on with this ID that this account can see. The action updates existing add-ons only; create the listing in the Developer Hub first.';
const METADATA_HINT = 'A listed version needs a license, name, summary and categories on the add-on. Set them in the Developer Hub; this action does not edit the listing.';
const KEY_REVOKED_HINT =
  'AMO found an API secret in the package and revokes that key 2 minutes after validation. Generate a new key, update both secrets, and find how the secret reached the build output.';
const LISTED_REVIEW_NOTE = 'Mozilla reviews listed versions; signing can take 24 hours or longer, and any version can still be reviewed later.';

interface Snapshot {
  complete: boolean;
  uuids: Set<string>;
  items: UploadItem[];
}

type CreateOutcome = { created: Version } | { trigger: 'lost' | '409' | 'already-submitted'; reason: string };

const plainDotted = (version: string) => /^\d+(\.\d+)*$/.test(version);

function compareDotted(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const normalized = (text: string | undefined) => (text ?? '').replace(/\r\n?/g, '\n').trim();

export async function publishToAmo(options: PublishOptions): Promise<PublishResult> {
  const { apiKey, apiSecret, addonId, version, channel, zip, zipName, source, sourceName = 'source.zip', releaseNotes, approvalNotes, compatibility, signedXpi } = options;
  const { dryRun = false, apiBase = AMO_BASE, waitTimeoutMinutes = 15, sleep = sleepFor, log = () => {}, warn = () => {}, output = () => {} } = options;
  const wait = options.wait === true || Boolean(signedXpi);
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const listed = channel === 'listed';
  const accountId = apiKey.split(':')[1];
  const client = amoClient({ apiBase, apiKey, apiSecret, mask: options.mask, log, sleep, retryDelayMs: timing.retryDelayMs });
  let sent = 'Nothing was uploaded.';
  const where = (method: string, path: string): Where => ({ method, path, sent });
  const get = (path: string): Request => ({ method: 'GET', path });

  async function readSite(): Promise<void> {
    const request: Request = { method: 'GET', path: '/api/v5/site/?disable_caching=1', auth: false };
    const reply = await client.read(request);
    if (reply.status !== 200) throw client.failure(request, reply);
    const site = client.parsed(request, reply);
    const offset = clockOffsetFrom(reply.headers.get('date'), reply.headers.get('age'));
    if (offset !== 0) {
      client.clockOffset = offset;
      log(`The runner clock is ${Math.abs(offset)} s ${offset > 0 ? 'behind' : 'ahead of'} AMO's; JWT times are adjusted.`);
    }
    const notice = typeof site.notice === 'string' ? site.notice.trim() : '';
    const submitWarning = typeof site.submit_notification_warning === 'string' ? site.submit_notification_warning.trim() : '';
    if (submitWarning) warn(`AMO submission notice: ${submitWarning}`.slice(0, 2000));
    if (site.read_only === true) {
      if (!dryRun) throw new ActionError('AMO is read-only for maintenance. Re-run later.', notice ? `AMO notice: ${notice}`.slice(0, 2000) : undefined);
      warn('AMO is read-only for maintenance. A real run would stop here.');
    }
    if (notice) warn(`AMO notice: ${notice}`.slice(0, 2000));
  }

  async function readAddon(): Promise<Addon> {
    const path = `/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
    const request = get(path);
    const reply = await client.read(request);
    if (reply.status === 404) throw client.failure(request, reply, UPDATE_ONLY_HINT);
    if (reply.status === 401 || reply.status === 403) {
      const body = isObject(reply.body) ? reply.body : {};
      if (body.is_disabled_by_mozilla === true) throw new ActionError('Mozilla disabled this add-on.', 'AMO refuses new versions of an add-on that Mozilla disabled.');
      if (body.is_disabled_by_developer === true) throw new ActionError('The add-on is disabled by its developer, and this account is not one of its authors.', AUTHOR_HINT);
    }
    if (reply.status !== 200) throw client.failure(request, reply);
    const addon = decodeAddon(client.parsed(request, reply), where('GET', path));
    if (addon.guid !== addonId) throw unknownState(where('GET', path), 'guid', addon.guid);
    if (addon.status === 'disabled') throw new ActionError('Mozilla disabled this add-on.', 'AMO refuses new versions of an add-on that Mozilla disabled.');
    if (addon.status === 'deleted') throw new ActionError('AMO reports this add-on as deleted.', UPDATE_ONLY_HINT);
    if (addon.status === 'rejected' && listed) {
      throw new ActionError("AMO rejected this add-on's listing content and refuses listed versions until it is fixed in the Developer Hub.");
    }
    if (addon.isDisabled) {
      if (listed) throw new ActionError('Listed versions cannot be submitted while the add-on is disabled. Enable it in the Developer Hub.');
      warn('The add-on is disabled by its developer. AMO refuses listed versions while it is disabled, but accepts unlisted ones.');
    }
    if (addon.status === 'incomplete' && listed) log('AMO lists the add-on as incomplete: a listed version needs a name, summary, categories and a license on the add-on.');
    if (listed && addon.currentVersion && plainDotted(addon.currentVersion) && plainDotted(version) && compareDotted(version, addon.currentVersion) <= 0) {
      warn(`AMO will likely refuse ${version}: a listed version must be greater than the latest signed listed version (${addon.currentVersion} is public).`);
    }
    return addon;
  }

  async function checkAuthor(addon: Addon): Promise<void> {
    const path = `/api/v5/addons/addon/${addon.id}/authors/${accountId}/`;
    const request = get(path);
    const reply = await client.read(request);
    if (reply.status === 403 || reply.status === 404) throw client.failure(request, reply, AUTHOR_HINT);
    if (reply.status !== 200) throw client.failure(request, reply);
    const role = decodeRole(client.parsed(request, reply), where('GET', path));
    log(
      `AMO: add-on ${addonId} is ${addon.status}, and this account is ${
        role === 'owner' ? 'an owner of it. An account with the developer role cannot delete the add-on or change its authors; see the README.' : 'a developer of it.'
      }`,
    );
  }

  const addon = await (async () => {
    await readSite();
    const found = await readAddon();
    await checkAuthor(found);
    return found;
  })();
  const versionPath = (id: number) => `/api/v5/addons/addon/${addon.id}/versions/${id}/`;
  const lookupPath = `/api/v5/addons/addon/${addon.id}/versions/v${encodeURIComponent(version)}/`;

  async function lookup(): Promise<Version | undefined> {
    const request = get(lookupPath);
    const reply = await client.read(request);
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) throw client.failure(request, reply);
    const found = decodeVersion(client.parsed(request, reply), where('GET', lookupPath));
    if (found.version.toLowerCase() !== version.toLowerCase()) throw unknownState(where('GET', lookupPath), 'version', found.version);
    return found;
  }

  let state = '';
  function report(found: Version): void {
    state = found.fileStatus;
    output('state', state);
    output('version-id', String(found.id));
    const editUrl = checkedUrl(found.editUrl);
    if (editUrl) output('edit-url', editUrl);
  }

  function checkedUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
      const parsed = new URL(raw);
      return parsed.origin === new URL(apiBase).origin && parsed.href === raw ? parsed.href : undefined;
    } catch {
      return undefined;
    }
  }

  function accept(found: Version, ours: boolean): 'submitted' | 'skipped' {
    if (found.channel !== channel) {
      throw new ActionError(`Version ${version} already exists in the ${found.channel} channel. AMO allows each version number once across channels; increase version in manifest.json.`);
    }
    report(found);
    if (found.version !== version) log(`AMO stores this version as ${found.version}.`);
    if (found.isDisabled) throw new ActionError(`Version ${version} was disabled by a developer of the add-on. Re-enable it in the Developer Hub, or release a new version.`);
    if (found.fileStatus === 'disabled') {
      throw new ActionError(
        `AMO rejected or disabled version ${version}. Release a new version.`,
        listed ? 'Creating a newer listed version also disables an older listed version that is still awaiting review.' : undefined,
      );
    }
    const result = ours ? 'submitted' : 'skipped';
    output('result', result);
    return result;
  }

  function reportExisting(found: Version): void {
    log(`AMO: version ${version} already exists in the ${found.channel} channel (id ${found.id}), file status ${found.fileStatus}. Nothing to upload.`);
    if (found.channel === channel) log(`AMO cannot show whether version ${version} holds this build. To publish different code, increase version in manifest.json.`);
  }

  async function listUploads(): Promise<Snapshot> {
    const uuids = new Set<string>();
    const items: UploadItem[] = [];
    let undecodable = false;
    const incomplete = (reason: string): Snapshot => {
      log(`The upload list is incomplete (${reason}), so this run will not adopt an upload after a lost answer.`);
      return { complete: false, uuids, items };
    };
    for (let page = 1; page <= 20; page++) {
      const request = get(`${UPLOAD_PATH}?page_size=50&page=${page}`);
      let reply: Reply;
      try {
        reply = await client.read(request);
      } catch (error) {
        if (error instanceof AmoError) return incomplete(error.message);
        throw error;
      }
      const data = reply.status === 200 ? decodeUploadPage(reply.body) : undefined;
      if (!data) return incomplete(`page ${page} answered HTTP ${reply.status} without a readable list`);
      for (const raw of data.results) {
        if (isObject(raw) && typeof raw.uuid === 'string') uuids.add(raw.uuid);
        const item = decodeUploadItem(raw);
        if (item) items.push(item);
        else if (!undecodable) {
          undecodable = true;
          log(`An item of the upload list has fields the action cannot read: ${logSafe(raw)}. It is treated as not matching.`);
        }
      }
      if (data.next === null) {
        return uuids.size === data.count ? { complete: true, uuids, items } : incomplete(`${uuids.size} distinct uploads across the pages, but a count of ${data.count}`);
      }
    }
    return incomplete('more than 20 pages');
  }

  async function adopt(snapshot: Snapshot): Promise<Upload | undefined> {
    const again = await listUploads();
    if (!again.complete) return undefined;
    const fresh = [...again.uuids].filter((uuid) => !snapshot.uuids.has(uuid));
    const item = again.items.find((each) => each.uuid === fresh[0]);
    if (fresh.length !== 1 || !item || !UUID.test(item.uuid) || item.channel !== channel || item.submitted || (item.version !== null && item.version !== version)) {
      return undefined;
    }
    log(`Adopting upload ${item.uuid}: it is the only upload AMO's list gained since this run read it.`);
    return { uuid: item.uuid, channel, processed: false, submitted: false, valid: false, version: item.version, validation: null };
  }

  async function upload(snapshot: Snapshot): Promise<Upload> {
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append('channel', channel);
      form.append('upload', new File([zip], zipName, { type: 'application/zip' }));
      const request: Request = { method: 'POST', path: UPLOAD_PATH, form, file: true };
      let lost: string;
      try {
        const reply = await client.write(request);
        if (reply.status === 201 && isObject(reply.body)) {
          sent = UPLOADED;
          const created = decodeUpload(reply.body, where('POST', UPLOAD_PATH));
          if (created.channel !== channel) throw unknownState(where('POST', UPLOAD_PATH), 'channel', created.channel);
          return created;
        }
        if (reply.status !== 201 && !ambiguousStatus(reply)) throw client.failure(request, reply);
        lost = reply.status === 201 ? `POST ${UPLOAD_PATH} returned HTTP 201 with a body that is not JSON` : client.failure(request, reply).message;
      } catch (error) {
        if (!(error instanceof AmoError) || !error.ambiguous) throw error;
        lost = error.message;
      }
      sent = 'The package may have reached AMO, but no version was created.';
      if (attempt >= 2) throw new ActionError('The upload may or may not have reached AMO. Nothing was submitted. Re-running is safe.', lost);
      log(`The answer to the upload was lost (${lost}).`);
      const adopted = snapshot.complete ? await adopt(snapshot) : undefined;
      if (adopted) return adopted;
      log('Uploading once more.');
    }
  }

  const formatMessage = (message: ValidationMessage) => `${message.message}${message.file ? ` (${message.file}${message.line ? ` line ${message.line}` : ''})` : ''}`.slice(0, 2000);

  async function validate(first: Upload): Promise<Upload> {
    const path = `${UPLOAD_PATH}${first.uuid}/`;
    const request = get(path);
    let failures = 0;
    const failed = (problem: Error) => {
      failures += 1;
      if (failures >= 3) throw problem;
    };
    await sleep(timing.validationFirstMs);
    for (let check = 1; check <= timing.validationChecks; check++) {
      if (check > 1) await sleep(timing.validationIntervalMs);
      if (check % 6 === 0) log('AMO is still validating the upload.');
      let reply: Reply;
      try {
        reply = await client.send(request);
      } catch (error) {
        if (!(error instanceof AmoError) || !error.retryable) throw error;
        failed(error);
        continue;
      }
      if (POLL_FAILURES.has(reply.status) || (reply.status === 404 && check <= 3) || (reply.status === 200 && !isObject(reply.body))) {
        failed(client.failure(request, reply));
        continue;
      }
      if (reply.status !== 200) throw client.failure(request, reply);
      failures = 0;
      const current = decodeUpload(reply.body, where('GET', path));
      if (current.processed) return current;
    }
    const minutes = Math.round((timing.validationFirstMs + timing.validationChecks * timing.validationIntervalMs) / 60_000);
    throw new ActionError(`AMO was still validating after ${minutes} minutes. The upload stays unsubmitted and AMO deletes it after 15 days. Re-run this job.`);
  }

  function checkValidation(done: Upload): void {
    const messages = validationMessages(done.validation);
    if (messages?.some(isValidationTimeout)) {
      throw new ActionError("AMO's validator timed out on this upload, and AMO refuses to create a version from it. Re-run to upload again.");
    }
    if (!done.valid) {
      const errors = messages
        ? messages
            .filter((message) => message.type === 'error')
            .slice(0, 20)
            .map((message) => `${message.file ? `${message.file}${message.line ? `:${message.line}` : ''} ` : ''}${message.message}`.slice(0, 2000))
        : [JSON.stringify(done.validation ?? null).slice(0, 2000)];
      const keyFound = messages?.some((message) => message.id.some((part) => part.includes('api_key_detected')));
      throw new ActionError(`AMO's validation refused version ${version}.`, [...errors, ...(keyFound ? [KEY_REVOKED_HINT] : [])].join('\n'));
    }
    if (done.version !== version) throw new ActionError(`AMO read version ${logSafe(done.version)} from the package, the action read ${version}.`);
    if (done.channel !== channel) throw unknownState(where('GET', `${UPLOAD_PATH}${done.uuid}/`), 'channel', done.channel);
    if (done.submitted) throw new ActionError(`Upload ${done.uuid} was submitted by another writer before this run could use it.`, RERUN_SAFE);
    const warnings = (messages ?? []).filter((message) => message.type === 'warning');
    log(`Validation passed${warnings.length > 0 ? ` with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.`);
    for (const message of warnings.slice(0, 20)) warn(`AMO validation warning: ${formatMessage(message)}`);
  }

  const createPath = `/api/v5/addons/addon/${addon.id}/versions/`;

  function createRequest(uuid: string): Request {
    if (source) {
      const form = new FormData();
      form.append('upload', uuid);
      form.append('source', new File([source], sourceName, { type: 'application/zip' }));
      if (approvalNotes) form.append('approval_notes', approvalNotes);
      return { method: 'POST', path: createPath, form, file: true };
    }
    return {
      method: 'POST',
      path: createPath,
      json: {
        upload: uuid,
        ...(releaseNotes ? { release_notes: { 'en-US': releaseNotes } } : {}),
        ...(approvalNotes ? { approval_notes: approvalNotes } : {}),
        ...(compatibility ? { compatibility } : {}),
      },
    };
  }

  async function sendCreate(uuid: string): Promise<CreateOutcome> {
    const request = createRequest(uuid);
    let reply: Reply;
    try {
      reply = await client.write(request);
    } catch (error) {
      if (error instanceof AmoError && error.ambiguous) return { trigger: 'lost', reason: error.message };
      throw error;
    }
    if (reply.status === 201) {
      sent = `Version ${version} was created on AMO.`;
      if (!isObject(reply.body) || !Number.isSafeInteger(reply.body.id)) return { trigger: 'lost', reason: `POST ${createPath} returned HTTP 201 without a readable version` };
      const created = decodeVersion(reply.body, where('POST', createPath));
      if (created.version !== version) throw unknownState(where('POST', createPath), 'version', created.version);
      if (created.channel !== channel) throw unknownState(where('POST', createPath), 'channel', created.channel);
      return { created };
    }
    const versionErrors = fieldMessages(reply.body, 'version');
    const uploadErrors = fieldMessages(reply.body, 'upload');
    if (reply.status === 409 && versionErrors.length > 0) return { trigger: '409', reason: versionErrors.join(' ') };
    if (reply.status === 400 && uploadErrors.some((message) => /already been submitted/i.test(message))) return { trigger: 'already-submitted', reason: uploadErrors.join(' ') };
    if (ambiguousStatus(reply)) return { trigger: 'lost', reason: client.failure(request, reply).message };
    if (reply.status !== 400) throw client.failure(request, reply);
    if (uploadErrors.some((message) => /not valid/i.test(message))) {
      throw client.failure(request, reply, "The upload failed validation, or AMO's validator timed out on it. Re-run to upload again.");
    }
    if (versionErrors.some((message) => /greater than/i.test(message))) throw client.failure(request, reply, 'Increase version in manifest.json.');
    if (listed && (fieldMessages(reply.body, 'license').length > 0 || /metadata|summary|categor/i.test(JSON.stringify(reply.body ?? '')))) {
      throw client.failure(request, reply, METADATA_HINT);
    }
    throw client.failure(request, reply);
  }

  async function resolve(uuid: string, outcome: Exclude<CreateOutcome, { created: Version }>): Promise<{ found: Version; ours: boolean } | undefined> {
    const uploadRequest = get(`${UPLOAD_PATH}${uuid}/`);
    const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof AmoError) throw new ActionError(`Version ${version} may have been created, but its state is unknown: ${error.message}`, RERUN_SAFE);
        throw error;
      }
    };
    const readSubmitted = () =>
      guarded(async () => {
        const reply = await client.read(uploadRequest);
        if (reply.status !== 200) throw client.failure(uploadRequest, reply);
        return decodeUpload(client.parsed(uploadRequest, reply), where('GET', uploadRequest.path)).submitted;
      });
    const readVersion = () => guarded(lookup);
    const pause = () => sleep(timing.resolutionDelayMs);

    await pause();
    let submitted = await readSubmitted();
    let found = await readVersion();
    for (let round = 1; ; round++) {
      if (found) {
        if (found.channel !== channel) accept(found, false);
        if (!submitted) {
          await pause();
          submitted = await readSubmitted();
        }
        if (submitted) log(`AMO created version ${version}; its response was lost.`);
        else warn(`Another writer created version ${version}; this run's upload was not used.`);
        return { found, ours: submitted };
      }
      if (submitted) {
        for (let reread = 0; reread < 3 && !found; reread++) {
          await pause();
          found = await readVersion();
        }
        if (found) continue;
        throw new ActionError(`AMO reports upload ${uuid} as submitted but has no version ${version}. Check the Developer Hub before re-running.`);
      }
      if (outcome.trigger === '409') {
        throw new ActionError(`AMO says version ${version} was used before: ${outcome.reason} A version number can never be reused on AMO, even after deletion. Increase version in manifest.json.`);
      }
      if (outcome.trigger === 'already-submitted') {
        if (round > 1) {
          throw new ActionError(`AMO refused upload ${uuid} as already submitted, yet shows it unsubmitted and has no version ${version}.`, 'Check the Developer Hub before re-running.');
        }
        await pause();
        submitted = await readSubmitted();
        found = await readVersion();
        continue;
      }
      return undefined;
    }
  }

  async function create(uuid: string): Promise<{ found: Version; ours: boolean }> {
    let outcome = await sendCreate(uuid);
    for (let resolution = 1; !('created' in outcome); resolution++) {
      sent = `The package was uploaded to AMO, and version ${version} may have been created.`;
      log(`The create request for version ${version} gave no clear answer (${outcome.reason}). Reading AMO's state before deciding.`);
      const resolved = await resolve(uuid, outcome);
      if (resolved) return resolved;
      if (resolution >= 2) throw new ActionError(`The version was not created, or its state is unknown. ${RERUN_SAFE}`, outcome.reason);
      log(`AMO has no version ${version} and upload ${uuid} is unused, so the create is sent once more.`);
      outcome = await sendCreate(uuid);
    }
    const stored = outcome.created;
    const carried = [typeof stored.source === 'string' && 'the source ZIP', normalized(stored.releaseNotes) && 'release notes', normalized(stored.approvalNotes) && 'approval notes'].filter(Boolean);
    log(`Created version ${version} (id ${stored.id}) in the ${channel} channel${carried.length > 0 ? `, with ${carried.join(' and ')}` : ''}. File status: ${stored.fileStatus}.`);
    return { found: outcome.created, ours: true };
  }

  async function readById(id: number): Promise<Version> {
    const request = get(versionPath(id));
    const reply = await client.read(request);
    if (reply.status !== 200) throw client.failure(request, reply);
    return decodeVersion(client.parsed(request, reply), where('GET', request.path));
  }

  async function patch(current: Version, build: () => Request, what: string, missing: (found: Version) => boolean): Promise<Version> {
    for (let attempt = 1; ; attempt++) {
      const request = build();
      let lost: string;
      try {
        const reply = await client.write(request);
        if (reply.status === 200 && isObject(reply.body)) return decodeVersion(reply.body, where('PATCH', request.path));
        if (reply.status !== 200 && (definiteUnavailable(reply) || !ambiguousStatus(reply))) throw client.failure(request, reply);
        lost = reply.status === 200 ? `PATCH ${request.path} returned HTTP 200 with a body that is not JSON` : client.failure(request, reply).message;
      } catch (error) {
        if (!(error instanceof AmoError) || !error.ambiguous) throw error;
        lost = error.message;
      }
      if (attempt >= 2) throw new ActionError(`Setting ${what} on version ${version} failed: ${lost}`, `${RERUN_SAFE} It completes what is missing.`);
      log(`Setting ${what} gave no clear answer (${lost}). Reading the version again.`);
      const fresh = await readById(current.id);
      if (!missing(fresh)) return fresh;
    }
  }

  async function complete(found: Version, ours: boolean, versionWhere: Where): Promise<Version> {
    let current = found;
    const reviewed = current.fileStatus === 'public';
    let needSource = false;
    let needApproval = false;
    let needNotes = false;
    if (source) {
      if (current.source === undefined) throw unknownState(versionWhere, 'source', undefined);
      if (current.source !== null) {
        if (!ours) log(`AMO already holds a source archive for version ${version}; the action never replaces it.`);
      } else if (reviewed) {
        warn(
          `Version ${version} is already approved without source code. AMO refuses a source change after a human review, and adding source notifies Mozilla staff, reviewers and the other authors. Upload it in the Developer Hub if a reviewer asks.`,
        );
      } else needSource = true;
    }
    if (approvalNotes) {
      if (!normalized(current.approvalNotes)) {
        if (reviewed) log(`Version ${version} is already approved, so the approval notes are not sent: review is over.`);
        else needApproval = true;
      } else if (!ours && !reviewed && normalized(current.approvalNotes) !== normalized(approvalNotes)) {
        warn(`Version ${version} has other approval notes on AMO. The action leaves them; edit them in the Developer Hub.`);
      }
    }
    let needCompatibility = false;
    if (compatibility) {
      if (current.compatibility === undefined) throw unknownState(versionWhere, 'compatibility', undefined);
      if (!compatibilityMatches(compatibility, current.compatibility)) {
        needCompatibility = true;
        if (!ours) log(`Version ${version} is compatible with ${describeCompatibility(current.compatibility)} on AMO; the compatibility input asks for ${describeCompatibility(compatibility)}.`);
      }
    }
    if (releaseNotes) {
      if (!normalized(current.releaseNotes)) needNotes = true;
      else if (!ours && normalized(current.releaseNotes) !== normalized(releaseNotes)) {
        warn(`Version ${version} has other release notes on AMO. The action leaves them; edit them in the Developer Hub.`);
      }
    }
    const path = versionPath(current.id);
    if (dryRun) {
      if (needSource) log(`Dry run: a real run would send PATCH ${path} with the source ZIP${needApproval ? ' and the approval notes' : ''}.`);
      const fields = [needNotes && 'the release notes', needApproval && !needSource && 'the approval notes', needCompatibility && 'the compatibility'].filter(Boolean);
      if (fields.length > 0) log(`Dry run: a real run would send PATCH ${path} with ${fields.join(' and ')}.`);
      return current;
    }
    if (needSource) {
      const withApproval = needApproval;
      current = await patch(
        current,
        () => {
          const form = new FormData();
          form.append('source', new File([source!], sourceName, { type: 'application/zip' }));
          if (withApproval) form.append('approval_notes', approvalNotes!);
          return { method: 'PATCH', path, form, file: true };
        },
        'the source ZIP',
        (fresh) => fresh.source === null,
      );
      log(`Added the source ZIP${withApproval ? ' and the approval notes' : ''}.`);
      if (normalized(current.approvalNotes)) needApproval = false;
    }
    if (needNotes || needApproval || needCompatibility) {
      const json = {
        ...(needNotes ? { release_notes: { 'en-US': releaseNotes } } : {}),
        ...(needApproval ? { approval_notes: approvalNotes } : {}),
        ...(needCompatibility ? { compatibility } : {}),
      };
      const names = [needNotes && 'release notes', needApproval && 'approval notes', needCompatibility && 'compatibility'].filter(Boolean).join(' and ');
      const compatibilityMissing = (fresh: Version) => needCompatibility && (fresh.compatibility === undefined || !compatibilityMatches(compatibility!, fresh.compatibility));
      current = await patch(
        current,
        () => ({ method: 'PATCH', path, json }),
        `the ${names}`,
        (fresh) => (needNotes && !normalized(fresh.releaseNotes)) || (needApproval && !normalized(fresh.approvalNotes)) || compatibilityMissing(fresh),
      );
      if (compatibilityMissing(current)) {
        throw new ActionError(
          `AMO answered the compatibility change on version ${version} with ${describeCompatibility(current.compatibility ?? {})}, not ${describeCompatibility(compatibility!)}.`,
          'Check the versions exist on AMO, and that manifest.json does not set a different range.',
        );
      }
      log(`Set the ${names}${needCompatibility ? ` (${describeCompatibility(current.compatibility!)})` : ''}.`);
    }
    return current;
  }

  async function waitForSigning(current: Version): Promise<Version> {
    const path = versionPath(current.id);
    const request = get(path);
    const checks = waitTimeoutMinutes * 4;
    let failures = 0;
    log(`Waiting up to ${waitTimeoutMinutes} minutes for AMO to sign version ${version}.`);
    for (let check = 1; check <= checks; check++) {
      if (check > 1) await sleep(timing.waitIntervalMs);
      if (check > 1 && (check - 1) % 4 === 0) log(`Version ${version} is still unreviewed.`);
      let reply: Reply;
      try {
        reply = await client.send(request);
      } catch (error) {
        if (!(error instanceof AmoError) || !error.retryable) throw error;
        if (++failures >= 3) throw error;
        continue;
      }
      if (POLL_FAILURES.has(reply.status) || (reply.status === 200 && !isObject(reply.body))) {
        if (++failures >= 3) throw client.failure(request, reply);
        continue;
      }
      if (reply.status !== 200) throw client.failure(request, reply);
      failures = 0;
      const fresh = decodeVersion(reply.body, where('GET', path));
      state = fresh.fileStatus;
      output('state', state);
      if (fresh.isDisabled) throw new ActionError(`A developer of the add-on disabled version ${version} while the action waited.`);
      if (fresh.fileStatus === 'disabled') throw new ActionError(`AMO rejected or disabled version ${version} while the action waited.`);
      if (fresh.fileStatus === 'public') {
        log(`AMO signed version ${version}.`);
        return fresh;
      }
    }
    throw new ActionError(
      `Version ${version} is still unreviewed after ${waitTimeoutMinutes} minutes. It stays submitted; re-run this job later to wait again and download it, or raise wait-timeout.`,
      listed ? LISTED_REVIEW_NOTE : undefined,
    );
  }

  let found = await lookup();
  let result: PublishResult['result'];
  let ours = false;
  let versionWhere = where('GET', lookupPath);
  if (found) {
    reportExisting(found);
    result = accept(found, false);
  } else {
    log(`AMO: version ${version} does not exist yet.`);
    const snapshot = await listUploads();
    const earlier = snapshot.items.filter((item) => item.version === version && item.channel === channel && !item.submitted).length;
    if (earlier > 0) {
      log(
        `AMO holds ${earlier} unsubmitted upload${earlier === 1 ? '' : 's'} of version ${version} (${channel}) from earlier runs. AMO keeps no hash of them, so this run uploads again. AMO deletes them after 15 days.`,
      );
    }
    if (dryRun) {
      const extras = [source && 'the source ZIP', releaseNotes && 'release notes', approvalNotes && 'approval notes', compatibility && `compatibility ${describeCompatibility(compatibility)}`].filter(Boolean);
      log(`Dry run: version ${version} would be uploaded to the ${channel} channel and created${extras.length > 0 ? ` with ${extras.join(', ')}` : ''}. Nothing was sent to AMO.`);
      output('result', 'dry-run');
      output('state', '');
      return { result: 'dry-run', state: '' };
    }
    const uploaded = await upload(snapshot);
    sent = UPLOADED;
    log(`Uploaded ${zipName} (${Math.max(1, Math.round(zip.length / 1024))} KB) to the ${channel} channel. AMO is validating it.`);
    const validated = await validate(uploaded);
    checkValidation(validated);
    const created = await create(validated.uuid);
    sent = `Version ${version} exists on AMO.`;
    found = created.found;
    ours = created.ours;
    versionWhere = where('POST', createPath);
    if (!ours) reportExisting(found);
    result = accept(found, ours);
  }

  let current = await complete(found, ours, versionWhere);
  if (current.fileStatus !== state) report(current);
  if (wait && current.fileStatus === 'unreviewed') {
    if (dryRun) log(`Dry run: a real run would wait up to ${waitTimeoutMinutes} minutes for AMO to sign version ${version}.`);
    else current = await waitForSigning(current);
  } else if (listed && current.fileStatus === 'unreviewed') {
    const editUrl = checkedUrl(current.editUrl);
    log(`${LISTED_REVIEW_NOTE}${editUrl ? ` Developer Hub: ${editUrl}` : ''}`);
  }
  if (signedXpi && current.fileStatus === 'public') {
    if (dryRun) log(`Dry run: a real run would download the signed file to ${signedXpi}.`);
    else {
      await downloadSignedFile({ client, apiBase, url: current.fileUrl, hash: current.fileHash, size: current.fileSize, target: signedXpi, addonId, version });
      output('signed-xpi', signedXpi);
      log(`Wrote the signed file to ${signedXpi} after checking its SHA-256, size and signature entries.`);
      return { result, state, versionId: current.id, signedXpi };
    }
  }
  return { result, state, versionId: current.id };
}
