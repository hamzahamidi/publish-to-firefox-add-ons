import { createHmac, randomUUID } from 'node:crypto';

export const SHORT_LIFETIME = 90;
export const LONG_LIFETIME = 300;
const BACKDATE = 30;
const IGNORED_OFFSET_MS = 10_000;

export interface TokenOptions {
  apiKey: string;
  apiSecret: string;
  lifetime: number;
  clockOffset?: number;
  now?: number;
}

const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

export function mintToken({ apiKey, apiSecret, lifetime, clockOffset = 0, now = Date.now() }: TokenOptions): string {
  const iat = Math.floor(now / 1000) + clockOffset - BACKDATE;
  const claims = { iss: apiKey, jti: randomUUID(), iat, exp: iat + lifetime };
  const body = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  return `${body}.${createHmac('sha256', Buffer.from(apiSecret, 'utf8')).update(body).digest('base64url')}`;
}

export function clockOffsetFrom(date: string | null, age: string | null, now = Date.now()): number {
  if (!date || Number(age) > 0) return 0;
  const origin = Date.parse(date);
  if (Number.isNaN(origin)) return 0;
  const offset = origin + 500 - now;
  return Math.abs(offset) <= IGNORED_OFFSET_MS ? 0 : Math.round(offset / 1000);
}
