import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, describe, it } from 'node:test';
import { ACTION_VERSION, AmoError, amoClient, type ClientOptions, quotaHint, type Request, retryAfterSeconds, USER_AGENT } from '../src/client.ts';
import { API_KEY, API_SECRET, closedPort, type MockStore, startMockStore } from './helpers.ts';

let server: MockStore;
let elsewhere: MockStore;
before(async () => {
  server = await startMockStore();
  elsewhere = await startMockStore();
});
afterEach(() => {
  server.reset();
  elsewhere.reset();
});
after(async () => {
  await server.close();
  await elsewhere.close();
});

function client(options: Partial<ClientOptions> = {}) {
  const masked: string[] = [];
  const slept: number[] = [];
  const lines: string[] = [];
  const instance = amoClient({
    apiBase: server.base,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    mask: (value) => masked.push(value),
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...options,
  });
  return Object.assign(instance, { masked, slept, lines });
}

async function rejection(promise: Promise<unknown>): Promise<AmoError> {
  const error: unknown = await promise.then(
    () => assert.fail('expected the call to fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof AmoError, `expected AmoError, got ${error}`);
  return error;
}

const get = (path = '/thing/'): Request => ({ method: 'GET', path });

describe('amoClient', () => {
  it('sends Accept, User-Agent and a masked JWT, and parses JSON', async () => {
    server.on('GET /thing/', { body: { ok: true } });
    const amo = client();
    const reply = await amo.send(get());
    assert.deepEqual(reply.body, { ok: true });
    const [request] = server.requests;
    assert.equal(request!.accept, 'application/json');
    assert.equal(request!.userAgent, USER_AGENT);
    assert.match(request!.auth ?? '', /^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(amo.masked, [request!.auth!.slice(4)]);
  });

  it('sends no Authorization header when auth is off, and JSON with its content type', async () => {
    server.on('GET /site/', { body: {} });
    server.on('POST /write/', { status: 201, body: { id: 1 } });
    const amo = client();
    await amo.send({ method: 'GET', path: '/site/', auth: false });
    await amo.send({ method: 'POST', path: '/write/', json: { a: 1 } });
    assert.equal(server.requests[0]!.auth, undefined);
    assert.equal(server.requests[1]!.contentType, 'application/json');
    assert.equal(server.requests[1]!.body, '{"a":1}');
    assert.equal(amo.masked.length, 1);
  });

  it('uses the newest CHANGELOG version in the User-Agent', () => {
    const newest = /^## (\d+\.\d+\.\d+)/m.exec(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'))?.[1];
    assert.equal(ACTION_VERSION, newest);
    assert.ok(USER_AGENT.startsWith(`publish-to-firefox-add-ons/${newest} `));
  });

  for (const method of ['GET', 'POST', 'PATCH'] as const) {
    it(`refuses a redirect on ${method}, so no request reaches the other server`, async () => {
      server.on(`${method} /thing/`, { status: 307, headers: { Location: `${elsewhere.base}/stolen` } });
      const error = await rejection(client().send({ method, path: '/thing/', json: method === 'GET' ? undefined : {} }));
      assert.equal(error.message, `${method} /thing/ answered with a redirect (HTTP 307), which the action refuses to follow.`);
      assert.equal(elsewhere.requests.length, 0);
    });
  }

  it('refuses a redirect on an absolute download URL', async () => {
    server.on('GET /file.xpi', { status: 302, headers: { Location: `${elsewhere.base}/file.xpi` } });
    const error = await rejection(client().send({ method: 'GET', path: `${server.base}/file.xpi`, file: true, binary: true }));
    assert.match(error.message, /^GET \/file\.xpi answered with a redirect \(HTTP 302\)/);
    assert.equal(elsewhere.requests.length, 0);
  });

  it('reports a network failure and a timeout with their cause, as ambiguous', async () => {
    const refused = await rejection(client({ apiBase: `http://127.0.0.1:${await closedPort()}` }).send({ method: 'POST', path: '/x/', json: {} }));
    assert.match(refused.message, /^POST \/x\/ failed: .*ECONNREFUSED/);
    assert.equal(refused.ambiguous, true);
    assert.match(refused.details ?? '', /Re-running is safe/);
    server.on('GET /slow/', { delayMs: 2000 });
    const slow = await rejection(client({ getTimeoutMs: 50 }).send(get('/slow/')));
    assert.match(slow.message, /^GET \/slow\/ failed: .*(timeout|aborted)/i);
  });

  it('reports a body that breaks off while it is read', async () => {
    server.on('POST /thing/', { status: 201, partial: true });
    const error = await rejection(client().send({ method: 'POST', path: '/thing/', json: {} }));
    assert.match(error.message, /^POST \/thing\/ returned HTTP 201, then failed while reading the response: \S/);
    assert.equal(error.ambiguous, true);
  });

  it('refuses an answer larger than it reads, announced or streamed', async () => {
    server.on('GET /big/', { body: 'x'.repeat(100) });
    const streamed = await rejection(client({ maxBodyBytes: 10 }).send(get('/big/')));
    assert.match(streamed.message, /larger than 10 bytes/);
    server.on('GET /announced/', { body: 'x'.repeat(100), headers: { 'Content-Length': '100' } });
    const announced = await rejection(client({ maxBodyBytes: 10 }).send(get('/announced/')));
    assert.match(announced.message, /^GET \/announced\/ announced 100 bytes, more than the 10 the action reads\.$/);
  });

  it('keeps a body that is not JSON as text, and parsed() refuses it', async () => {
    server.on('GET /html/', { body: '<html>oops</html>' });
    server.on('POST /html/', { body: '<html>oops</html>' });
    const amo = client();
    const reply = await amo.send(get('/html/'));
    assert.equal(reply.body, undefined);
    assert.equal(reply.text, '<html>oops</html>');
    const error = (() => {
      try {
        amo.parsed(get('/html/'), reply);
      } catch (caught) {
        return caught as AmoError;
      }
      return undefined;
    })();
    assert.equal(error?.message, 'GET /html/ returned a response that is not JSON: <html>oops</html>');
    const write = await amo.send({ method: 'POST', path: '/html/', json: {} });
    assert.throws(() => amo.parsed({ method: 'POST', path: '/html/' }, write), (caught) => caught instanceof AmoError && caught.ambiguous && /Re-running is safe/.test(caught.details ?? ''));
  });

  it('formats AMO errors per status, with the hints of section 8', async () => {
    const cases: Array<[number, unknown, string, RegExp | undefined, Request?]> = [
      [400, { version: ['Bad.', 'Worse.'], non_field_errors: ['General.'] }, 'version: Bad.; Worse. General.', undefined],
      [401, { detail: 'Invalid API Key.' }, 'Invalid API Key.', /AMO does not know this API key/],
      [403, { detail: 'User has not read developer agreement.' }, 'User has not read developer agreement.', /Distribution Agreement/],
      [403, { detail: 'Nope.' }, 'Nope.', /not an author of this add-on/],
      [406, 'blocked', 'blocked', undefined],
      [409, { version: ['Version 1.0 already exists.'] }, 'version: Version 1.0 already exists.', undefined],
      [500, '', '(empty body)', undefined],
      [500, '', '(empty body)', /AMO may have received the request/, { method: 'POST', path: '/thing/' }],
      [502, { detail: 'Bad gateway.' }, 'Bad gateway.', undefined],
      [400, [], '[]', undefined],
      [400, {}, '{}', undefined],
    ];
    const amo = client();
    for (const [status, body, reason, hint, request = get()] of cases) {
      server.on(`${request.method} /thing/`, { status, body });
      const reply = await amo.send(request);
      const error = amo.failure(request, reply);
      assert.equal(error.message, `${request.method} /thing/ returned HTTP ${status}: ${reason}`);
      if (hint) assert.match(error.details ?? '', hint);
      else assert.equal(error.details, undefined, `${status} ${reason}`);
    }
  });

  it('gives the bandwidth hint when a file request took 200 s or more and met an expired token', async () => {
    server.on('POST /upload/', { status: 401, body: { detail: 'Signature has expired.' } });
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => realNow() + (++calls > 2 ? 250_000 : 0);
    let reply;
    const amo = client();
    const request: Request = { method: 'POST', path: '/upload/', form: new FormData(), file: true };
    try {
      reply = await amo.send(request);
    } finally {
      Date.now = realNow;
    }
    assert.equal(reply.seconds, 250);
    assert.match(amo.failure(request, reply).details ?? '', /^The request took 250 s\. AMO checks the token when the request arrives in full, and a token lives 5 minutes at most\./);
    reply.seconds = 3;
    assert.match(amo.failure(request, reply).details ?? '', /^The runner clock differs/);
  });

  it('retries a read twice on network errors and 5xx, then gives up', async () => {
    server.on('GET /flaky/', { status: 503 }, { status: 200, body: { ok: 1 } });
    const amo = client();
    assert.deepEqual((await amo.read(get('/flaky/'))).body, { ok: 1 });
    assert.deepEqual(amo.slept, [5000]);
    assert.match(amo.lines[0] ?? '', /^GET \/flaky\/ returned HTTP 503: \{\} Trying again in 5 s\.$/);
    server.on('GET /down/', { status: 500 });
    const error = await rejection(amo.read(get('/down/')));
    assert.match(error.message, /HTTP 500/);
    assert.equal(server.requests.filter((request) => request.key === 'GET /down/').length, 3);
    const closed = client({ apiBase: `http://127.0.0.1:${await closedPort()}` });
    assert.match((await rejection(closed.read(get()))).message, /failed: /);
    assert.equal(closed.slept.length, 2);
  });

  it('retries a read whose answer is not a JSON object, then stops quoting it', async () => {
    server.on('GET /edge/', { body: '<html>Bad gateway</html>' }, { body: { ok: 1 } });
    const amo = client();
    assert.deepEqual((await amo.read(get('/edge/'))).body, { ok: 1 });
    assert.deepEqual(amo.slept, [5000]);
    assert.equal(amo.lines[0], 'GET /edge/ returned a response that is not JSON: <html>Bad gateway</html> Trying again in 5 s.');
    server.on('GET /html/', { body: `<html>${'x'.repeat(3000)}</html>` });
    const error = await rejection(amo.read(get('/html/')));
    assert.equal(error.message, `GET /html/ returned a response that is not JSON: <html>${'x'.repeat(1994)}`);
    assert.equal(error.ambiguous, false);
    assert.equal(server.requests.filter((request) => request.key === 'GET /html/').length, 3);
    server.on('GET /list/', { body: [] });
    await rejection(amo.read(get('/list/')));
    server.on('GET /file.xpi', { body: 'PK binary' });
    assert.equal((await amo.read({ method: 'GET', path: '/file.xpi', file: true, binary: true })).bytes.toString(), 'PK binary');
    server.on('GET /missing/', { status: 404, body: '<html>Not found</html>' });
    assert.equal((await amo.read(get('/missing/'))).status, 404);
  });

  it('returns other statuses from a read without retrying', async () => {
    server.on('GET /gone/', { status: 404, body: { detail: 'Not found.' } });
    assert.equal((await client().read(get('/gone/'))).status, 404);
    assert.equal(server.requests.length, 1);
  });

  it('waits for Retry-After on a write, at most twice per run and 120 s at most', async () => {
    server.on('POST /w/', { status: 429, headers: { 'Retry-After': '7' } }, { status: 429, headers: { 'Retry-After': '7' } }, { status: 429, headers: { 'Retry-After': '7' } });
    const amo = client();
    const error = await rejection(amo.write({ method: 'POST', path: '/w/', json: {} }));
    assert.deepEqual(amo.slept, [7000, 7000]);
    assert.equal(error.details, quotaHint(7));
    assert.match(amo.lines[0] ?? '', /^AMO throttled POST \/w\/; waiting 7 s as its Retry-After header asks\.$/);
    server.on('POST /long/', { status: 429, headers: { 'Retry-After': '121' } });
    const long = client();
    await rejection(long.write({ method: 'POST', path: '/long/', json: {} }));
    assert.deepEqual(long.slept, []);
    server.on('POST /ok/', { status: 429, headers: { 'Retry-After': '1' } }, { status: 201, body: { id: 1 } });
    assert.equal((await client().write({ method: 'POST', path: '/ok/', json: {} })).status, 201);
  });

  it('reads Retry-After in seconds or as an HTTP date, and words the quota hint', () => {
    const now = Date.UTC(2026, 8, 26);
    assert.equal(retryAfterSeconds('30', now), 30);
    assert.equal(retryAfterSeconds(new Date(now + 90_500).toUTCString(), now), 90);
    assert.equal(retryAfterSeconds(new Date(now - 5000).toUTCString(), now), 0);
    assert.equal(retryAfterSeconds('soon', now), undefined);
    assert.equal(retryAfterSeconds(null, now), undefined);
    assert.match(quotaHint(3600), /Try again after 60 minutes\.$/);
    assert.match(quotaHint(10), /Try again after 1 minutes\.$/);
    assert.match(quotaHint(undefined), /Try again after a few minutes\.$/);
  });

  it('shifts every token by the clock offset', async () => {
    server.on('GET /thing/', { body: {} });
    const amo = client();
    amo.clockOffset = 100;
    await amo.send(get());
    const claims = JSON.parse(Buffer.from(server.requests[0]!.auth!.split('.')[1]!, 'base64url').toString());
    assert.ok(Math.abs(claims.iat - (Math.floor(Date.now() / 1000) + 70)) <= 1);
  });
});
