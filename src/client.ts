import { errorReason, isObject } from './decode.ts';
import { ActionError, networkReason } from './errors.ts';
import { LONG_LIFETIME, mintToken, SHORT_LIFETIME } from './jwt.ts';

export const AMO_BASE = 'https://addons.mozilla.org';
export const ACTION_VERSION = '1.0.0';
export const USER_AGENT = `publish-to-firefox-add-ons/${ACTION_VERSION} (+https://github.com/hamzahamidi/publish-to-firefox-add-ons)`;
export const MAX_BODY_BYTES = 250_000_000;

export const RERUN_HINT = 'AMO may have received the request. Re-running is safe: the action looks the version up first.';
export const AUTHOR_HINT =
  'The account behind api-key is not an author of this add-on. Add it under Manage Authors in the Developer Hub with the developer role, and accept the invitation from that account.';
const REGION_HINT = "AMO restricts this add-on in the runner's country. Run the job from another region.";
const EDGE_HINT = "AMO refused this runner's network at its edge; it blocks some hosting providers' address ranges. Use a GitHub-hosted runner or another network.";
const PAUSED_HINT = 'AMO is read-only for maintenance, or has paused submissions. Re-running is safe: the action looks the version up first.';
const BUG_HINT = 'This is a bug in the action; please report it.';
const DETAIL_HINTS: Array<[RegExp, string]> = [
  [
    /^(Unknown JWT iss \(issuer\)|Invalid API Key)\.?$/,
    'AMO does not know this API key. It was revoked or regenerated: generating a new key in the Developer Hub revokes the old one at once, and AMO revokes a key it finds inside an uploaded package. Update both secrets.',
  ],
  [/^(Error decoding signature|Invalid JWT Token)\.?$/, 'api-secret does not belong to api-key. Copy both from the same generation on the API Credentials page.'],
  [/^(Signature has expired\.?|JWT iat \(issued at time\) is invalid)/, "The runner clock differs from AMO's by more than the action corrects. AMO allows 5 s of leeway; check the runner's time synchronisation."],
  [/^User has not read developer agreement/, 'Sign in to the Developer Hub with this account and accept the Firefox Add-on Distribution Agreement.'],
  [/^User account is disabled/, 'The Mozilla account behind this key was deleted or disabled.'],
  [/^JWT (exp \(expiration\) is too long|iss \(issuer\) claim is missing)|orig_iat/, BUG_HINT],
];
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

export interface Request {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  auth?: boolean;
  json?: unknown;
  form?: FormData;
  file?: boolean;
  binary?: boolean;
}

export interface Reply {
  status: number;
  headers: Headers;
  bytes: Buffer;
  text: string;
  body: unknown;
  seconds: number;
}

export class AmoError extends ActionError {
  readonly status: number | undefined;
  readonly ambiguous: boolean;

  constructor(message: string, details: string | undefined, { status, ambiguous = false, retryable = false }: { status?: number; ambiguous?: boolean; retryable?: boolean } = {}) {
    super(message, details, { retryable });
    this.name = 'AmoError';
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export interface ClientOptions {
  apiBase: string;
  apiKey: string;
  apiSecret: string;
  mask?: (value: string) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  getTimeoutMs?: number;
  jsonTimeoutMs?: number;
  fileTimeoutMs?: number;
  maxBodyBytes?: number;
  maxRetryAfterSeconds?: number;
}

export interface AmoClient {
  clockOffset: number;
  send(request: Request): Promise<Reply>;
  read(request: Request, tries?: number): Promise<Reply>;
  write(request: Request): Promise<Reply>;
  failure(request: Request, reply: Reply, hint?: string): AmoError;
  parsed(request: Request, reply: Reply): Record<string, unknown>;
}

export const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function definiteUnavailable(reply: Reply): boolean {
  return reply.status === 503 && isObject(reply.body) && typeof reply.body.error === 'string';
}

export function ambiguousStatus(reply: Reply): boolean {
  return reply.status === 500 || reply.status === 502 || reply.status === 504 || (reply.status === 503 && !definiteUnavailable(reply));
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\s*\d+\s*$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

export function quotaHint(seconds: number | undefined): string {
  const after = seconds === undefined ? 'a few minutes' : `${Math.max(1, Math.ceil(seconds / 60))} minutes`;
  return `AMO throttled this account: at most 6 uploads per minute, 20 per hour and 48 per day, and 3 submissions per minute, 10 per hour and 24 per day, shared by every add-on and job using the account. Try again after ${after}.`;
}

export function amoClient({
  apiBase,
  apiKey,
  apiSecret,
  mask = () => {},
  log = () => {},
  sleep = sleepFor,
  retryDelayMs = 5_000,
  getTimeoutMs = 60_000,
  jsonTimeoutMs = 120_000,
  fileTimeoutMs = 600_000,
  maxBodyBytes = MAX_BODY_BYTES,
  maxRetryAfterSeconds = 120,
}: ClientOptions): AmoClient {
  let throttleWaits = 0;
  const label = (request: Request) => `${request.method} ${/^https?:/.test(request.path) ? new URL(request.path).pathname : request.path}`;

  function statusHint(request: Request, reply: Reply): string | undefined {
    const detail = isObject(reply.body) && typeof reply.body.detail === 'string' ? reply.body.detail.trim() : '';
    if (reply.status === 401) {
      if (/^Signature has expired/.test(detail) && request.file && reply.seconds >= 200) {
        return `The request took ${reply.seconds} s. AMO checks the token when the request arrives in full, and a token lives 5 minutes at most. A 200 MB package needs about 6 Mbit/s of upload bandwidth; use a faster runner or a smaller package.`;
      }
      return DETAIL_HINTS.find(([pattern]) => pattern.test(detail))?.[1];
    }
    if (reply.status === 403) {
      if (isObject(reply.body) && reply.body.code === 'permission_denied_restriction') return 'AMO restricts submissions from this account or network.';
      return DETAIL_HINTS.find(([pattern]) => pattern.test(detail))?.[1] ?? AUTHOR_HINT;
    }
    if (reply.status === 406 && !reply.text.trim()) return EDGE_HINT;
    if (reply.status === 413) return 'The package is larger than AMO accepts.';
    if (reply.status === 451) return REGION_HINT;
    if (definiteUnavailable(reply)) return PAUSED_HINT;
    if (reply.status >= 500 && request.method !== 'GET') return RERUN_HINT;
    return undefined;
  }

  function failure(request: Request, reply: Reply, hint?: string): AmoError {
    const reason = reply.status === 406 && !reply.text.trim() ? '(empty body)' : errorReason(reply.status, reply.body, reply.text);
    return new AmoError(`${label(request)} returned HTTP ${reply.status}: ${reason}`, hint ?? statusHint(request, reply), {
      status: reply.status,
      ambiguous: request.method !== 'GET' && ambiguousStatus(reply),
    });
  }

  function parsed(request: Request, reply: Reply): Record<string, unknown> {
    if (isObject(reply.body)) return reply.body;
    throw new AmoError(`${label(request)} returned a response that is not JSON: ${reply.text.slice(0, 2000)}`, request.method === 'GET' ? undefined : RERUN_HINT, {
      status: reply.status,
      ambiguous: request.method !== 'GET',
    });
  }

  async function readBody(response: Response): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBodyBytes) {
          await response.body.cancel().catch(() => {});
          throw new AmoError(`The answer is larger than ${maxBodyBytes.toLocaleString('en-US')} bytes, the most the action reads.`, undefined, { status: response.status });
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }

  const client: AmoClient = {
    clockOffset: 0,
    failure,
    parsed,

    async send(request) {
      const started = Date.now();
      const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
      if (request.auth !== false) {
        const token = mintToken({ apiKey, apiSecret, lifetime: request.file ? LONG_LIFETIME : SHORT_LIFETIME, clockOffset: client.clockOffset });
        mask(token);
        headers.Authorization = `JWT ${token}`;
      }
      let body: string | FormData | undefined = request.form;
      if (request.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(request.json);
      }
      const timeoutMs = request.file ? fileTimeoutMs : request.method === 'GET' ? getTimeoutMs : jsonTimeoutMs;
      const rerun = request.method === 'GET' ? undefined : RERUN_HINT;
      let response: Response;
      try {
        response = await fetch(/^https?:/.test(request.path) ? request.path : apiBase + request.path, {
          method: request.method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AmoError(`${label(request)} failed: ${networkReason(error)}`, rerun, { ambiguous: true, retryable: true });
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new AmoError(`${label(request)} answered with a redirect (HTTP ${response.status}), which the action refuses to follow.`, undefined, { status: response.status });
      }
      const length = Number(response.headers.get('content-length'));
      if (length > maxBodyBytes) {
        await response.body?.cancel().catch(() => {});
        throw new AmoError(`${label(request)} announced ${length.toLocaleString('en-US')} bytes, more than the ${maxBodyBytes.toLocaleString('en-US')} the action reads.`, undefined, {
          status: response.status,
        });
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(response);
      } catch (error) {
        if (error instanceof AmoError) throw error;
        throw new AmoError(`${label(request)} returned HTTP ${response.status}, then failed while reading the response: ${networkReason(error)}`, rerun, {
          status: response.status,
          ambiguous: true,
          retryable: true,
        });
      }
      const text = request.binary && response.ok ? '' : bytes.toString('utf8');
      let parsedBody: unknown;
      try {
        parsedBody = text ? JSON.parse(text) : undefined;
      } catch {
        parsedBody = undefined;
      }
      return { status: response.status, headers: response.headers, bytes, text, body: parsedBody, seconds: Math.round((Date.now() - started) / 1000) };
    },

    async read(request, tries = 3) {
      for (let attempt = 1; ; attempt++) {
        let problem: AmoError;
        try {
          const reply = await client.send(request);
          if (reply.status === 429) {
            if (attempt >= tries) throw failure(request, reply, quotaHint(retryAfterSeconds(reply.headers.get('retry-after'))));
            await sleep(throttleWait(request, reply));
            continue;
          }
          if (!RETRYABLE_STATUSES.has(reply.status)) return reply;
          problem = failure(request, reply);
        } catch (error) {
          if (!(error instanceof AmoError) || !error.retryable) throw error;
          problem = error;
        }
        if (attempt >= tries) throw problem;
        log(`${problem.message} Trying again in ${retryDelayMs / 1000} s.`);
        await sleep(retryDelayMs);
      }
    },

    async write(request) {
      for (;;) {
        const reply = await client.send(request);
        if (reply.status !== 429) return reply;
        await sleep(throttleWait(request, reply));
      }
    },
  };

  function throttleWait(request: Request, reply: Reply): number {
    const seconds = retryAfterSeconds(reply.headers.get('retry-after'));
    if (seconds === undefined || seconds > maxRetryAfterSeconds || throttleWaits >= 2) throw failure(request, reply, quotaHint(seconds));
    throttleWaits += 1;
    log(`AMO throttled ${label(request)}; waiting ${seconds} s as its Retry-After header asks.`);
    return seconds * 1000;
  }

  return client;
}
