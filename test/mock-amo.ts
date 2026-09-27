import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCOUNT, ADDON_ID, API_KEY, API_SECRET, makeZip, unzip } from './helpers.ts';

export type Route = 'site' | 'addon' | 'author' | 'version' | 'version:create' | 'version:patch' | 'upload:create' | 'upload:list' | 'upload' | 'download' | 'unknown';

export interface Fault {
  status?: number;
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  redirect?: string;
  drop?: 'before' | 'after';
  hang?: boolean;
  partial?: boolean;
  notJson?: boolean;
  delayMs?: number;
  mutate?: (body: any) => unknown;
  concurrentWriter?: boolean;
  then?: () => void;
}

export interface Account {
  id: number;
  key: string;
  secret: string;
  agreed: boolean;
  disabled: boolean;
}

export interface MockAddon {
  id: number;
  guid: string;
  slug: string;
  status: string;
  isDisabled: boolean;
  authors: Map<number, string>;
  hasLicense: boolean;
  hasMetadata: boolean;
  restricted: boolean;
}

export interface MockUpload {
  uuid: string;
  channel: string;
  user: number;
  filename: string;
  bytes: Buffer;
  manifestVersion: string | null;
  geckoId: string | undefined;
  pollsLeft: number;
  processed: boolean;
  valid: boolean;
  messages: unknown[];
  versionOverride: string | undefined;
  submitted: boolean;
}

export interface MockVersion {
  id: number;
  addonId: number;
  version: string;
  channel: string;
  fileId: number;
  fileStatus: string;
  isDisabled: boolean;
  signed: boolean;
  releaseNotes: Record<string, string> | null;
  approvalNotes: string;
  source: string | null;
  deleted: boolean;
  humanReviewed: boolean;
  bytes: Buffer;
  reads: number;
  compatibility: Record<string, { min: string; max: string }>;
}

export interface UploadResult {
  valid?: boolean;
  messages?: unknown[];
  version?: string;
  polls?: number;
}

export interface MockConfig {
  readOnly: boolean;
  notice: string;
  submitWarning: string;
  clockSkewSeconds: number;
  age: string | undefined;
  multipartApprovalNotes: boolean;
  pageSize: number;
  unstableList: boolean;
  signAfterReads: number | undefined;
  rejectAfterReads: number | undefined;
  throttle: { uploads: number; submissions: number; retryAfter: string } | undefined;
}

export interface FormPart {
  value?: string;
  filename?: string;
  size?: number;
  sha256?: string;
}

export interface AmoRequest {
  seq: number;
  route: Route;
  method: string;
  url: string;
  call: string;
  auth: string | undefined;
  token: string | undefined;
  verdict: string;
  userAgent: string | undefined;
  accept: string | undefined;
  contentType: string | undefined;
  json: unknown;
  form: Record<string, FormPart> | undefined;
  size: number;
}

interface Result {
  status: number;
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
}

export interface MockAmo {
  base: string;
  config: MockConfig;
  requests: AmoRequest[];
  accounts: Map<string, Account>;
  addon: MockAddon;
  addons: MockAddon[];
  uploads: MockUpload[];
  versions: MockVersion[];
  onRequest: ((request: AmoRequest) => void) | undefined;
  calls(): string[];
  fault(route: Route, ...faults: Fault[]): void;
  stale(route: 'version' | 'upload', reads: number): void;
  queueUpload(...results: UploadResult[]): void;
  addAccount(account: Partial<Account> & { id: number; key: string; secret: string }): Account;
  addAddon(addon: Partial<MockAddon>): MockAddon;
  addVersion(version: Partial<MockVersion> & { version: string }): MockVersion;
  addUpload(upload: Partial<MockUpload>): MockUpload;
  sign(version: MockVersion): void;
  reject(version: MockVersion): void;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_CONFIG: MockConfig = {
  readOnly: false,
  notice: '',
  submitWarning: '',
  clockSkewSeconds: 0,
  age: undefined,
  multipartApprovalNotes: true,
  pageSize: 50,
  unstableList: false,
  signAfterReads: undefined,
  rejectAfterReads: undefined,
  throttle: undefined,
};
const DEFAULT_COMPATIBILITY: Record<string, { min: string; max: string }> = { firefox: { min: '109.0', max: '*' }, android: { min: '120.0', max: '*' } };
const APP_VERSIONS = new Set(['*', '109.0', '115.0', '120.0', '128.0', '140.0', '140.*', '142.0']);

function geckoAndroid(bytes: Buffer): boolean {
  try {
    return typeof JSON.parse(unzip(bytes).get('manifest.json')!.toString('utf8')).browser_specific_settings?.gecko_android === 'object';
  } catch {
    return false;
  }
}

function defaultCompatibility(bytes: Buffer): Record<string, { min: string; max: string }> {
  return { firefox: DEFAULT_COMPATIBILITY.firefox!, ...(geckoAndroid(bytes) ? { android: DEFAULT_COMPATIBILITY.android! } : {}) };
}

const SIGNATURE_FILES = ['META-INF/mozilla.rsa', 'META-INF/mozilla.sf', 'META-INF/manifest.mf'];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const notFound: Result = { status: 404, body: { detail: 'Not found.' } };
const forbidden: Result = { status: 403, body: { detail: 'You do not have permission to perform this action.' } };

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function routeOf(method: string, segments: string[]): Route {
  const [api, v5, addons, kind, id, child, childId] = segments;
  if (segments[0] === 'firefox' && segments[1] === 'downloads' && segments.length === 5) return 'download';
  if (api !== 'api' || v5 !== 'v5') return 'unknown';
  if (addons === 'site' && segments.length === 3) return 'site';
  if (addons !== 'addons') return 'unknown';
  if (kind === 'upload') return id === undefined ? (method === 'POST' ? 'upload:create' : 'upload:list') : 'upload';
  if (kind !== 'addon' || id === undefined) return 'unknown';
  if (child === undefined) return 'addon';
  if (child === 'authors' && childId !== undefined) return 'author';
  if (child !== 'versions') return 'unknown';
  if (childId === undefined) return method === 'POST' ? 'version:create' : 'unknown';
  return method === 'PATCH' ? 'version:patch' : 'version';
}

export async function startMockAmo(): Promise<MockAmo> {
  let seq = 0;
  let nextAddonId = 1234;
  let nextVersionId = 5812345;
  let nextFileId = 900;
  let counts = { uploads: 0, submissions: 0 };
  const faults = new Map<Route, Fault[]>();
  const staleReads = { version: 0, upload: 0 };
  const uploadQueue: UploadResult[] = [];

  function authenticate(header: string | undefined): { account?: Account; error: string } {
    const [scheme, token] = (header ?? '').split(' ');
    if (scheme !== 'JWT' || !token) return { error: 'Authentication credentials were not provided.' };
    const parts = token.split('.');
    let head: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      head = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    } catch {
      return { error: 'Error decoding signature.' };
    }
    const account = mock.accounts.get(String(claims.iss));
    if (!account) return { error: 'Unknown JWT iss (issuer).' };
    const expected = createHmac('sha256', account.secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (parts.length !== 3 || head.alg !== 'HS256' || expected !== parts[2]) return { error: 'Error decoding signature.' };
    const now = Date.now() / 1000 + mock.config.clockSkewSeconds;
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return { error: 'Invalid JWT Token.' };
    if (claims.exp < now - 5) return { error: 'Signature has expired.' };
    if (claims.iat > now + 5) return { error: 'JWT iat (issued at time) is invalid. Make sure your system clock is synchronized with something like TLSNotary.' };
    if (claims.exp - claims.iat > 300) return { error: 'JWT exp (expiration) is too long.' };
    if ('orig_iat' in claims) return { error: 'orig_iat field not allowed.' };
    if (account.disabled) return { error: 'User account is disabled.' };
    if (!account.agreed) return { error: 'User has not read developer agreement.' };
    return { account, error: '' };
  }

  const findAddon = (key: string) => mock.addons.find((addon) => String(addon.id) === key || addon.guid === key || addon.slug === key);
  const latestPublicListed = (addon: MockAddon) =>
    mock.versions.filter((each) => each.addonId === addon.id && each.channel === 'listed' && each.fileStatus === 'public' && !each.deleted).sort((a, b) => a.id - b.id).at(-1);

  function versionJson(version: MockVersion): Record<string, unknown> {
    const addon = mock.addons.find((each) => each.id === version.addonId)!;
    return {
      id: version.id,
      version: version.version,
      channel: version.channel,
      edit_url: `${mock.base}/en-US/developers/addon/${addon.slug}/versions/${version.id}`,
      is_disabled: version.isDisabled,
      approval_notes: version.approvalNotes,
      release_notes: version.releaseNotes,
      source: version.source,
      file: {
        id: version.fileId,
        status: version.fileStatus,
        url: `${mock.base}/firefox/downloads/file/${version.fileId}/${addon.slug}-${version.version}.xpi`,
        hash: `sha256:${sha256(version.bytes)}`,
        size: version.bytes.length,
        is_mozilla_signed_extension: false,
        permissions: [],
      },
      compatibility: version.compatibility,
      license: { id: 6, slug: 'MPL-2.0' },
      reviewed: null,
    };
  }

  function addonJson(addon: MockAddon): Record<string, unknown> {
    const current = latestPublicListed(addon);
    return {
      id: addon.id,
      guid: addon.guid,
      slug: addon.slug,
      status: addon.status,
      is_disabled: addon.isDisabled,
      current_version: current ? versionJson(current) : null,
      name: { 'en-US': 'Test add-on' },
      type: 'extension',
    };
  }

  function uploadJson(upload: MockUpload): Record<string, unknown> {
    return {
      uuid: upload.uuid,
      channel: upload.channel,
      processed: upload.processed,
      submitted: upload.submitted,
      url: `${mock.base}/api/v5/addons/upload/${upload.uuid}/`,
      valid: upload.processed && upload.valid,
      validation: upload.processed ? { errors: 0, warnings: 0, messages: upload.messages } : null,
      version: upload.processed ? (upload.versionOverride ?? upload.manifestVersion) : null,
    };
  }

  function compatibilityFrom(value: unknown, bytes: Buffer, current: MockVersion['compatibility']): MockVersion['compatibility'] | Result {
    const refuse = (message: string): Result => ({ status: 400, body: { compatibility: [message] } });
    const entries = Array.isArray(value) ? value.map((app) => [app, {}] as const) : typeof value === 'object' && value !== null ? Object.entries(value) : undefined;
    if (!entries) return refuse('Invalid value');
    const next: MockVersion['compatibility'] = {};
    for (const [app, range] of entries) {
      if (app !== 'firefox' && app !== 'android') return refuse(`Invalid app specified: ${String(app)}`);
      const { min, max } = range as { min?: string; max?: string };
      const known = (version: string | undefined) => version === undefined || APP_VERSIONS.has(version);
      if (!known(min) || !known(max)) return refuse(`Unknown ${min && !known(min) ? 'min' : 'max'} app version specified`);
      const held = current[app] ?? DEFAULT_COMPATIBILITY[app]!;
      if (app === 'android' && geckoAndroid(bytes) && ((min && min !== held.min) || (max && max !== held.max))) {
        return refuse('Can not override compatibility information set in the manifest for this application (Firefox for Android)');
      }
      next[app] = { min: min ?? held.min, max: max ?? held.max };
    }
    return next;
  }

  function readManifest(bytes: Buffer): { version: string | null; geckoId: string | undefined } {
    try {
      const text = unzip(bytes).get('manifest.json')!.toString('utf8').replace(/^﻿/, '');
      const manifest = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''));
      const settings = manifest.browser_specific_settings ?? manifest.applications;
      return { version: typeof manifest.version === 'string' ? manifest.version : null, geckoId: settings?.gecko?.id };
    } catch {
      return { version: null, geckoId: undefined };
    }
  }

  function sourceProblem(part: File | undefined): Result | undefined {
    if (!part) return undefined;
    if (!/\.(zip|tar\.gz|tgz|tar\.bz2)$/.test(part.name)) return { status: 400, body: { source: ['Unsupported file type, please upload an archive file (.zip, .tar.gz, .tgz, .tar.bz2).'] } };
    return undefined;
  }

  async function sourceUrl(part: File, version: number): Promise<string | Result> {
    try {
      if (part.name.endsWith('.zip')) unzip(Buffer.from(await part.arrayBuffer()));
    } catch {
      return { status: 400, body: { source: ['Invalid or broken archive.'] } };
    }
    return `${mock.base}/api/v5/addons/addon/source/${version}/${part.name}`;
  }

  const throttled = (kind: 'uploads' | 'submissions'): Result | undefined => {
    const limit = mock.config.throttle;
    if (!limit) return undefined;
    counts[kind] += 1;
    if (counts[kind] <= limit[kind]) return undefined;
    return { status: 429, body: { detail: 'Request was throttled.' }, headers: { 'Retry-After': limit.retryAfter } };
  };

  async function createVersion(addon: MockAddon, account: Account, fields: Record<string, unknown>, form: FormData | undefined): Promise<Result> {
    const upload = mock.uploads.find((each) => each.uuid === fields.upload && each.user === account.id);
    if (!upload) return { status: 400, body: { upload: ['This upload does not exist or does not belong to you.'] } };
    if (upload.submitted) return { status: 400, body: { upload: ['This upload has already been submitted.'] } };
    const timedOut = upload.messages.some((message) => JSON.stringify((message as { id?: unknown }).id) === '["validator","unexpected_exception","validation_timeout"]');
    if (!upload.processed || !upload.valid || timedOut) return { status: 400, body: { upload: ['Upload is not valid.'] } };
    if (upload.geckoId && upload.geckoId !== addon.guid) {
      return { status: 400, body: { non_field_errors: [`The add-on ID in your manifest.json (${upload.geckoId}) does not match the ID of your add-on on AMO (${addon.guid})`] } };
    }
    const number = (upload.versionOverride ?? upload.manifestVersion)!;
    const clash = mock.versions.find((each) => each.addonId === addon.id && each.version.toLowerCase() === number.toLowerCase());
    if (clash) return { status: 409, body: { version: [clash.deleted ? `Version ${number} was uploaded before and deleted.` : `Version ${number} already exists.`] } };
    if (upload.channel === 'listed') {
      if (addon.isDisabled) return { status: 400, body: { non_field_errors: ['Listed versions cannot be submitted while add-on is disabled.'] } };
      if (addon.status === 'rejected') return { status: 400, body: { non_field_errors: ['Listed versions cannot be submitted while the listing is rejected.'] } };
      const signed = mock.versions.filter((each) => each.addonId === addon.id && each.channel === 'listed' && each.signed).sort((a, b) => a.id - b.id).at(-1);
      if (signed && compareVersions(number, signed.version) <= 0) {
        return { status: 400, body: { version: [`Version ${number} must be greater than the previous approved version ${signed.version}.`] } };
      }
      if (!addon.hasLicense && !fields.license) return { status: 400, body: { license: ['This field is required for listed versions.'] } };
      if (!addon.hasMetadata) return { status: 400, body: { non_field_errors: ["Add-on metadata is required to be set to create a listed version: ['summary', 'categories']."] } };
    }
    const sourcePart = form?.get('source');
    const sourceFile = sourcePart instanceof File ? sourcePart : undefined;
    const refused = sourceProblem(sourceFile);
    if (refused) return refused;
    const id = nextVersionId++;
    const source = sourceFile ? await sourceUrl(sourceFile, id) : null;
    if (source !== null && typeof source !== 'string') return source;
    if (upload.channel === 'listed') {
      for (const older of mock.versions) if (older.addonId === addon.id && older.channel === 'listed' && older.fileStatus === 'unreviewed') older.fileStatus = 'disabled';
    }
    const approval = form ? (mock.config.multipartApprovalNotes ? form.get('approval_notes') : null) : fields.approval_notes;
    const compatibility = fields.compatibility === undefined ? undefined : compatibilityFrom(fields.compatibility, upload.bytes, defaultCompatibility(upload.bytes));
    if (compatibility && 'status' in compatibility) return compatibility as Result;
    const version = mock.addVersion({
      ...(compatibility ? { compatibility: compatibility as MockVersion['compatibility'] } : {}),
      id,
      addonId: addon.id,
      version: number,
      channel: upload.channel,
      bytes: upload.bytes,
      releaseNotes: (fields.release_notes as Record<string, string> | undefined) ?? null,
      approvalNotes: typeof approval === 'string' ? approval : '',
      source,
    });
    upload.submitted = true;
    return { status: 201, body: versionJson(version) };
  }

  async function handle(route: Route, record: AmoRequest, url: URL, segments: string[], form: FormData | undefined, concurrentWriter: boolean): Promise<Result> {
    if (route === 'unknown') return notFound;
    if (route === 'site') {
      const now = new Date(Date.now() + mock.config.clockSkewSeconds * 1000);
      return {
        status: 200,
        body: { read_only: mock.config.readOnly, notice: mock.config.notice || null, submit_notification_warning: mock.config.submitWarning || null },
        headers: { Date: now.toUTCString(), ...(mock.config.age ? { Age: mock.config.age } : {}) },
      };
    }
    const { account, error } = authenticate(record.auth);
    if (!account) return { status: 401, body: { detail: error } };
    const fields: Record<string, unknown> = form ? Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string')) : ((record.json as Record<string, unknown>) ?? {});

    if (route === 'upload:create') {
      const busy = throttled('uploads');
      if (busy) return busy;
      const file = form?.get('upload');
      if (!(file instanceof File)) return { status: 400, body: { detail: 'Missing "upload" key in multipart file data.' } };
      if (!['listed', 'unlisted', 'enterprise'].includes(String(fields.channel))) return { status: 400, body: { channel: [`"${fields.channel}" is not a valid choice.`] } };
      if (!/\.(zip|xpi|crx)$/.test(file.name)) return { status: 400, body: { upload: ['Unsupported file type, please upload a supported file (.crx, .xpi, .zip).'] } };
      const bytes = Buffer.from(await file.arrayBuffer());
      const manifest = readManifest(bytes);
      const result = uploadQueue.shift() ?? {};
      const upload = mock.addUpload({
        channel: String(fields.channel),
        user: account.id,
        filename: file.name,
        bytes,
        manifestVersion: manifest.version,
        geckoId: manifest.geckoId,
        pollsLeft: result.polls ?? 1,
        processed: false,
        valid: result.valid ?? manifest.version !== null,
        messages: result.messages ?? [],
        versionOverride: result.version,
      });
      return { status: 201, body: uploadJson(upload) };
    }
    if (route === 'upload:list') {
      const mine = mock.uploads.filter((upload) => upload.user === account.id);
      const size = mock.config.pageSize;
      const page = Number(url.searchParams.get('page') ?? 1);
      const start = (page - 1) * size - (mock.config.unstableList && page > 1 ? 1 : 0);
      const next = page * size < mine.length ? `${mock.base}/api/v5/addons/upload/?page=${page + 1}&page_size=${size}` : null;
      return { status: 200, body: { count: mine.length, next, previous: null, results: mine.slice(start, start + size).map(uploadJson) } };
    }
    if (route === 'upload') {
      const upload = mock.uploads.find((each) => each.uuid === segments[4] && each.user === account.id);
      if (!upload) return notFound;
      if (!upload.processed && --upload.pollsLeft <= 0) upload.processed = true;
      const body = uploadJson(upload);
      if (staleReads.upload > 0) {
        staleReads.upload -= 1;
        body.submitted = false;
      }
      return { status: 200, body };
    }
    if (route === 'download') {
      const version = mock.versions.find((each) => each.fileId === Number(segments[3]));
      if (!version || version.deleted) return notFound;
      const addon = mock.addons.find((each) => each.id === version.addonId)!;
      if ((version.channel !== 'listed' || version.fileStatus !== 'public') && !addon.authors.has(account.id)) return notFound;
      return { status: 200, bytes: version.bytes, headers: { 'Content-Type': 'application/x-xpinstall' } };
    }

    const addon = findAddon(segments[4]!);
    if (!addon || addon.status === 'deleted') return notFound;
    const role = addon.authors.get(account.id);
    if (route === 'addon') {
      if (addon.restricted) return { status: 451, body: { detail: 'Unavailable for legal reasons.' } };
      if (!role && (addon.status !== 'public' || addon.isDisabled)) {
        return { ...forbidden, body: { ...(forbidden.body as object), is_disabled_by_developer: addon.isDisabled, is_disabled_by_mozilla: addon.status === 'disabled' } };
      }
      return { status: 200, body: addonJson(addon) };
    }
    if (!role) return forbidden;
    if (route === 'author') {
      const authorRole = addon.authors.get(Number(segments[6]));
      if (!authorRole) return notFound;
      return { status: 200, body: { user_id: Number(segments[6]), name: 'Test Developer', email: 'developer@example.com', role: authorRole, listed: true, position: 0 } };
    }
    if (route === 'version:create') {
      if (addon.status === 'disabled') return forbidden;
      const busy = throttled('submissions');
      if (busy) return busy;
      if (concurrentWriter) {
        const theirs = mock.uploads.find((each) => each.uuid === fields.upload);
        if (theirs) {
          const other = mock.addUpload({ ...theirs, uuid: randomBytes(16).toString('hex'), submitted: false });
          await createVersion(addon, account, { upload: other.uuid }, undefined);
        }
      }
      return createVersion(addon, account, fields, form);
    }

    const key = segments[6]!;
    const version = key.startsWith('v')
      ? mock.versions.find((each) => each.addonId === addon.id && each.version.toLowerCase() === key.slice(1).toLowerCase())
      : mock.versions.find((each) => each.addonId === addon.id && String(each.id) === key);
    if (route === 'version:patch') {
      if (!version || version.deleted) return notFound;
      const busy = throttled('submissions');
      if (busy) return busy;
      const sourcePart = form?.get('source');
      if (sourcePart instanceof File) {
        if (version.humanReviewed) return { status: 400, body: { source: ['Source cannot be changed because this version has been reviewed by Mozilla.'] } };
        const source = sourceProblem(sourcePart) ?? (await sourceUrl(sourcePart, version.id));
        if (typeof source !== 'string') return source;
        version.source = source;
      }
      if (fields.release_notes) version.releaseNotes = { ...version.releaseNotes, ...(fields.release_notes as Record<string, string>) };
      if (typeof fields.approval_notes === 'string') version.approvalNotes = fields.approval_notes;
      if (fields.compatibility !== undefined) {
        const compatibility = compatibilityFrom(fields.compatibility, version.bytes, version.compatibility);
        if ('status' in compatibility) return compatibility as Result;
        version.compatibility = compatibility as MockVersion['compatibility'];
      }
      return { status: 200, body: versionJson(version) };
    }
    if (staleReads.version > 0) {
      staleReads.version -= 1;
      return notFound;
    }
    if (!version || version.deleted) return notFound;
    if (!key.startsWith('v')) {
      version.reads += 1;
      if (version.fileStatus === 'unreviewed' && mock.config.signAfterReads !== undefined && version.reads >= mock.config.signAfterReads) mock.sign(version);
      if (version.fileStatus === 'unreviewed' && mock.config.rejectAfterReads !== undefined && version.reads >= mock.config.rejectAfterReads) mock.reject(version);
    }
    return { status: 200, body: versionJson(version) };
  }

  function send(res: ServerResponse, result: Result, text?: string): void {
    const payload = result.bytes ?? Buffer.from(text ?? (typeof result.body === 'string' ? result.body : result.body === undefined ? '' : JSON.stringify(result.body)));
    res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
    res.end(payload);
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const payload = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', mock.base);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? 'GET';
      const route = routeOf(method, segments);
      const contentType = req.headers['content-type'];
      let form: FormData | undefined;
      let json: unknown;
      if (contentType?.startsWith('multipart/form-data')) form = await new Response(payload, { headers: { 'content-type': contentType } }).formData();
      else if (contentType?.startsWith('application/json')) json = JSON.parse(payload.toString());
      const parts: Record<string, FormPart> = {};
      for (const [name, value] of form?.entries() ?? []) {
        if (typeof value === 'string') parts[name] = { value };
        else {
          const bytes = Buffer.from(await value.arrayBuffer());
          parts[name] = { filename: value.name, size: bytes.length, sha256: sha256(bytes) };
        }
      }
      const auth = req.headers.authorization;
      const record: AmoRequest = {
        seq: ++seq,
        route,
        method,
        url: req.url ?? '/',
        call: `${method} ${req.url}`,
        auth,
        token: auth?.startsWith('JWT ') ? auth.slice(4) : undefined,
        verdict: auth ? authenticate(auth).error || 'ok' : 'none',
        userAgent: req.headers['user-agent'],
        accept: req.headers.accept,
        contentType,
        json,
        form: form ? parts : undefined,
        size: payload.length,
      };
      mock.requests.push(record);
      mock.onRequest?.(record);
      const fault = faults.get(route)?.shift();
      if (fault?.delayMs) await new Promise((done) => setTimeout(done, fault.delayMs));
      fault?.then?.();
      if (fault?.drop === 'before') return void res.socket?.destroy();
      if (fault?.redirect) {
        res.writeHead(302, { Location: fault.redirect });
        return void res.end();
      }
      if (fault?.status !== undefined) return send(res, { status: fault.status, body: fault.body, bytes: fault.bytes, headers: fault.headers });
      const result = await handle(route, record, url, segments, form, fault?.concurrentWriter === true);
      if (fault?.drop === 'after') return void res.socket?.destroy();
      if (fault?.hang) return;
      if (fault?.partial) {
        res.writeHead(result.status, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        res.write('{"id');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (fault?.notJson) return send(res, result, '<html><body>Bad gateway</body></html>');
      if (fault?.mutate) result.body = fault.mutate(structuredClone(result.body));
      if (fault?.bytes) result.bytes = fault.bytes;
      if (fault?.headers) result.headers = { ...result.headers, ...fault.headers };
      send(res, result);
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));

  const mock: MockAmo = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    config: { ...DEFAULT_CONFIG },
    requests: [],
    accounts: new Map(),
    addon: undefined as unknown as MockAddon,
    addons: [],
    uploads: [],
    versions: [],
    onRequest: undefined,
    calls: () => mock.requests.map((request) => request.call),
    fault(route, ...added) {
      faults.set(route, [...(faults.get(route) ?? []), ...added]);
    },
    stale(route, reads) {
      staleReads[route] = reads;
    },
    queueUpload(...results) {
      uploadQueue.push(...results);
    },
    addAccount(account) {
      const full: Account = { agreed: true, disabled: false, ...account };
      mock.accounts.set(full.key, full);
      return full;
    },
    addAddon(addon) {
      const full: MockAddon = {
        id: nextAddonId++,
        guid: ADDON_ID,
        slug: 'my-extension',
        status: 'public',
        isDisabled: false,
        authors: new Map([[ACCOUNT, 'developer']]),
        hasLicense: true,
        hasMetadata: true,
        restricted: false,
        ...addon,
      };
      mock.addons.push(full);
      return full;
    },
    addVersion(version) {
      const bytes = version.bytes ?? makeZip([{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'Test add-on', version: version.version, browser_specific_settings: { gecko: { id: ADDON_ID } } }) }]);
      const full: MockVersion = {
        id: nextVersionId++,
        addonId: mock.addon.id,
        channel: 'listed',
        fileId: nextFileId++,
        fileStatus: 'unreviewed',
        isDisabled: false,
        signed: false,
        releaseNotes: null,
        approvalNotes: '',
        source: null,
        deleted: false,
        humanReviewed: false,
        reads: 0,
        compatibility: defaultCompatibility(bytes),
        ...version,
        bytes,
      };
      mock.versions.push(full);
      if (full.fileStatus === 'public' && !version.bytes) mock.sign(full);
      return full;
    },
    addUpload(upload) {
      const full: MockUpload = {
        uuid: randomBytes(16).toString('hex'),
        channel: 'listed',
        user: ACCOUNT,
        filename: 'extension.zip',
        bytes: Buffer.alloc(0),
        manifestVersion: null,
        geckoId: undefined,
        pollsLeft: 1,
        processed: true,
        valid: true,
        messages: [],
        versionOverride: undefined,
        submitted: false,
        ...upload,
      };
      mock.uploads.push(full);
      return full;
    },
    sign(version) {
      const files = [...unzip(version.bytes)].filter(([name]) => !SIGNATURE_FILES.includes(name)).map(([name, data]) => ({ name, data }));
      version.bytes = makeZip([...files, ...SIGNATURE_FILES.map((name) => ({ name, data: `signature ${name} for ${version.version}` }))]);
      version.fileStatus = 'public';
      version.signed = true;
    },
    reject(version) {
      version.fileStatus = 'disabled';
    },
    reset() {
      mock.config = { ...DEFAULT_CONFIG };
      mock.requests.length = 0;
      mock.accounts.clear();
      mock.addons.length = 0;
      mock.uploads.length = 0;
      mock.versions.length = 0;
      mock.onRequest = undefined;
      faults.clear();
      staleReads.version = 0;
      staleReads.upload = 0;
      uploadQueue.length = 0;
      counts = { uploads: 0, submissions: 0 };
      nextAddonId = 1234;
      mock.addAccount({ id: ACCOUNT, key: API_KEY, secret: API_SECRET });
      mock.addon = mock.addAddon({});
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
  mock.reset();
  return mock;
}
