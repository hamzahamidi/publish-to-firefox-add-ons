import { ActionError } from './errors.ts';

export const CHANNELS = ['listed', 'unlisted', 'enterprise'] as const;
export const ADDON_STATUSES = ['public', 'deleted', 'disabled', 'rejected', 'nominated', 'incomplete'] as const;
export const FILE_STATUSES = ['public', 'unreviewed', 'disabled'] as const;
export const ROLES = ['developer', 'owner'] as const;
export const VALIDATION_TIMEOUT_ID = ['validator', 'unexpected_exception', 'validation_timeout'];

export type Channel = (typeof CHANNELS)[number];
export type AddonStatus = (typeof ADDON_STATUSES)[number];
export type FileStatus = (typeof FILE_STATUSES)[number];
export type Role = (typeof ROLES)[number];
type Json = Record<string, unknown>;

export interface Where {
  method: string;
  path: string;
  sent: string;
}

export interface Addon {
  id: number;
  guid: string;
  status: AddonStatus;
  isDisabled: boolean;
  currentVersion: string | undefined;
}

export interface Version {
  id: number;
  version: string;
  channel: Channel;
  isDisabled: boolean;
  fileStatus: FileStatus;
  fileUrl: string | undefined;
  fileHash: string | undefined;
  fileSize: number | undefined;
  editUrl: string | undefined;
  releaseNotes: string | undefined;
  approvalNotes: string | undefined;
  source: string | null | undefined;
}

export interface Upload {
  uuid: string;
  channel: Channel;
  processed: boolean;
  submitted: boolean;
  valid: boolean;
  version: string | null;
  validation: unknown;
}

export interface UploadItem {
  uuid: string;
  channel: string;
  submitted: boolean;
  version: string | null;
}

export interface UploadPage {
  count: number;
  next: string | null;
  results: unknown[];
}

export interface ValidationMessage {
  type: string;
  message: string;
  id: string[];
  file: string | undefined;
  line: number | undefined;
}

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function logSafe(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'missing' : JSON.stringify(value) ?? String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function unknownState(where: Where, field: string, value: unknown): ActionError {
  return new ActionError(
    `AMO answered ${where.method} ${where.path} with ${field} = ${logSafe(value)}, which this version of the action does not know.`,
    `The v5 API may have changed. ${where.sent}`,
  );
}

function reader(where: Where, body: unknown, prefix = '') {
  const object: Json = isObject(body) ? body : {};
  const fail = (field: string): never => {
    throw unknownState(where, prefix + field, object[field]);
  };
  return {
    object,
    oneOf<T extends string>(field: string, values: readonly T[]): T {
      const value = object[field];
      return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fail(field);
    },
    id(field: string): number {
      const value = object[field];
      return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail(field);
    },
    string(field: string): string {
      const value = object[field];
      return typeof value === 'string' ? value : fail(field);
    },
    boolean(field: string): boolean {
      const value = object[field];
      return typeof value === 'boolean' ? value : fail(field);
    },
    optionalString(field: string): string | undefined {
      const value = object[field];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

export function decodeAddon(body: unknown, where: Where): Addon {
  const read = reader(where, body);
  const current = read.object.current_version;
  return {
    id: read.id('id'),
    guid: read.string('guid'),
    status: read.oneOf('status', ADDON_STATUSES),
    isDisabled: read.boolean('is_disabled'),
    currentVersion: isObject(current) && typeof current.version === 'string' ? current.version : undefined,
  };
}

export function decodeRole(body: unknown, where: Where): Role {
  return reader(where, body).oneOf('role', ROLES);
}

export function decodeVersion(body: unknown, where: Where): Version {
  const read = reader(where, body);
  if (!isObject(read.object.file)) throw unknownState(where, 'file', read.object.file);
  const file = reader(where, read.object.file, 'file.');
  const notes = read.object.release_notes;
  const enUs = isObject(notes) && typeof notes['en-US'] === 'string' ? notes['en-US'] : undefined;
  const source = read.object.source;
  const size = file.object.size;
  return {
    id: read.id('id'),
    version: read.string('version'),
    channel: read.oneOf('channel', CHANNELS),
    isDisabled: read.boolean('is_disabled'),
    fileStatus: file.oneOf('status', FILE_STATUSES),
    fileUrl: file.optionalString('url'),
    fileHash: file.optionalString('hash'),
    fileSize: Number.isSafeInteger(size) ? (size as number) : undefined,
    editUrl: read.optionalString('edit_url'),
    releaseNotes: enUs,
    approvalNotes: read.optionalString('approval_notes'),
    source: typeof source === 'string' || source === null ? source : undefined,
  };
}

export function decodeUpload(body: unknown, where: Where): Upload {
  const read = reader(where, body);
  const uuid = read.string('uuid');
  if (!/^[0-9a-f]{32}$/.test(uuid)) throw unknownState(where, 'uuid', uuid);
  const version = read.object.version;
  return {
    uuid,
    channel: read.oneOf('channel', CHANNELS),
    processed: read.boolean('processed'),
    submitted: read.boolean('submitted'),
    valid: read.boolean('valid'),
    version: typeof version === 'string' ? version : null,
    validation: read.object.validation,
  };
}

export function decodeUploadPage(body: unknown): UploadPage | undefined {
  if (!isObject(body) || !Number.isSafeInteger(body.count) || !Array.isArray(body.results)) return undefined;
  if (body.next !== null && typeof body.next !== 'string') return undefined;
  return { count: body.count as number, next: body.next, results: body.results };
}

export function decodeUploadItem(item: unknown): UploadItem | undefined {
  if (!isObject(item) || typeof item.uuid !== 'string' || typeof item.channel !== 'string' || typeof item.submitted !== 'boolean') return undefined;
  if (item.version !== null && item.version !== undefined && typeof item.version !== 'string') return undefined;
  return { uuid: item.uuid, channel: item.channel, submitted: item.submitted, version: typeof item.version === 'string' ? item.version : null };
}

export function validationMessages(validation: unknown): ValidationMessage[] | undefined {
  const messages = isObject(validation) ? validation.messages : undefined;
  if (!Array.isArray(messages)) return undefined;
  return messages.filter(isObject).map((message) => ({
    type: typeof message.type === 'string' ? message.type : '',
    message: typeof message.message === 'string' ? message.message : JSON.stringify(message),
    id: typeof message.id === 'string' ? [message.id] : Array.isArray(message.id) ? message.id.filter((part): part is string => typeof part === 'string') : [],
    file: typeof message.file === 'string' && message.file ? message.file : undefined,
    line: Number.isSafeInteger(message.line) ? (message.line as number) : undefined,
  }));
}

export function isValidationTimeout(message: ValidationMessage): boolean {
  return message.id.length === VALIDATION_TIMEOUT_ID.length && message.id.every((part, index) => part === VALIDATION_TIMEOUT_ID[index]);
}

function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (isObject(value)) return Object.entries(value).flatMap(([key, nested]) => flatten(nested).map((text) => `${key}: ${text}`));
  return value === undefined || value === null ? [] : [String(value)];
}

export function fieldMessages(body: unknown, field: string): string[] {
  return isObject(body) ? flatten(body[field]) : [];
}

export function errorReason(status: number, body: unknown, text: string): string {
  const fallback = text.slice(0, 2000) || '(empty body)';
  if (!isObject(body)) return fallback;
  if (status === 400 || status === 409) {
    const parts = Object.entries(body).map(([field, value]) => {
      const messages = flatten(value).join('; ');
      return field === 'detail' || field === 'non_field_errors' ? messages : `${field}: ${messages}`;
    });
    return parts.join(' ').slice(0, 2000) || fallback;
  }
  if (status === 401 || status === 403) {
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const code = typeof body.code === 'string' ? ` (${body.code})` : '';
    return detail ? `${detail}${code}`.slice(0, 2000) : fallback;
  }
  if (status === 503 && typeof body.error === 'string') {
    return `${body.error}${typeof body.reason === 'string' && body.reason ? ` ${body.reason}` : ''}`.slice(0, 2000);
  }
  return typeof body.detail === 'string' ? body.detail.slice(0, 2000) : fallback;
}
