import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { clockOffsetFrom, LONG_LIFETIME, mintToken, SHORT_LIFETIME } from '../src/jwt.ts';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

describe('mintToken', () => {
  it('signs an HS256 token with the key as issuer, backdated by 30 s', () => {
    const token = mintToken({ apiKey: 'user:1:2', apiSecret: 'secret', lifetime: SHORT_LIFETIME, now: NOW });
    const [header, claims, signature] = token.split('.');
    assert.deepEqual(decode(header!), { alg: 'HS256', typ: 'JWT' });
    const payload = decode(claims!);
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'iss', 'jti']);
    assert.equal(payload.iss, 'user:1:2');
    assert.equal(payload.iat, NOW / 1000 - 30);
    assert.equal(payload.exp, payload.iat + 90);
    assert.match(payload.jti, /^[0-9a-f-]{36}$/);
    assert.equal(signature, createHmac('sha256', Buffer.from('secret', 'utf8')).update(`${header}.${claims}`).digest('base64url'));
    assert.ok(!token.includes('='), 'base64url without padding');
  });

  it('gives requests that carry a file the server maximum of 300 s', () => {
    const payload = decode(mintToken({ apiKey: 'user:1:2', apiSecret: 's', lifetime: LONG_LIFETIME, now: NOW }).split('.')[1]!);
    assert.equal(payload.exp - payload.iat, 300);
    assert.equal(payload.orig_iat, undefined);
  });

  it('uses a fresh jti for every token', () => {
    const ids = new Set(Array.from({ length: 20 }, () => decode(mintToken({ apiKey: 'k', apiSecret: 's', lifetime: 90 }).split('.')[1]!).jti));
    assert.equal(ids.size, 20);
  });

  it('shifts the times by the clock offset', () => {
    const payload = decode(mintToken({ apiKey: 'k', apiSecret: 's', lifetime: 90, clockOffset: 42, now: NOW }).split('.')[1]!);
    assert.equal(payload.iat, NOW / 1000 + 42 - 30);
  });
});

describe('clockOffsetFrom', () => {
  const date = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toUTCString();

  it('ignores an offset of 10 s or less', () => {
    assert.equal(clockOffsetFrom(date(9), null, NOW), 0);
    assert.equal(clockOffsetFrom(date(-10), null, NOW), 0);
    assert.equal(clockOffsetFrom(date(10), null, NOW), 11);
  });

  it('reports a larger offset in whole seconds, rounding for the header resolution', () => {
    assert.equal(clockOffsetFrom(date(42), null, NOW), 43);
    assert.equal(clockOffsetFrom(date(-60), '0', NOW), -59);
  });

  it('ignores a cached answer, a missing header and a date it cannot parse', () => {
    assert.equal(clockOffsetFrom(date(120), '30', NOW), 0);
    assert.equal(clockOffsetFrom(null, null, NOW), 0);
    assert.equal(clockOffsetFrom('yesterday', null, NOW), 0);
  });
});
