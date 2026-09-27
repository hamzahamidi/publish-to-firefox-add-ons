import { ActionError } from './errors.ts';

export const APPS = ['firefox', 'android'] as const;
export type App = (typeof APPS)[number];
export type Range = { min?: string; max?: string };
export type Compatibility = App[] | Partial<Record<App, Range>>;
export type Ranges = Partial<Record<App, { min: string; max: string }>>;

const MIN_VERSION = /^\d{1,4}(\.\d{1,4}){0,3}([ab]\d{1,3})?$/;
const MAX_VERSION = /^(\*|\d{1,4}(\.\d{1,4}){0,3}([ab]\d{1,3})?(\.\*)?)$/;
const FORMAT = 'Pass a JSON array of applications, such as ["firefox","android"], or an object such as {"firefox":{"min":"128.0"},"android":{"min":"142.0"}}.';

const isApp = (value: unknown): value is App => typeof value === 'string' && (APPS as readonly string[]).includes(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseCompatibility(input: string): Compatibility | undefined {
  if (!input) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new ActionError('Input compatibility is not valid JSON.', FORMAT);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new ActionError('Input compatibility lists no application.', FORMAT);
    const unknown = value.filter((app) => !isApp(app));
    if (unknown.length > 0) throw new ActionError(`Input compatibility names ${JSON.stringify(unknown[0])}; AMO knows firefox and android.`, FORMAT);
    if (new Set(value).size !== value.length) throw new ActionError('Input compatibility names an application twice.');
    return value as App[];
  }
  if (!isObject(value)) throw new ActionError('Input compatibility must be a JSON array or object.', FORMAT);
  const apps = Object.keys(value);
  if (apps.length === 0) throw new ActionError('Input compatibility lists no application.', FORMAT);
  const result: Partial<Record<App, Range>> = {};
  for (const app of apps) {
    if (!isApp(app)) throw new ActionError(`Input compatibility names ${JSON.stringify(app)}; AMO knows firefox and android.`, FORMAT);
    const range = value[app];
    if (!isObject(range)) throw new ActionError(`Input compatibility.${app} must be an object with min, max or both.`, FORMAT);
    const extra = Object.keys(range).find((key) => key !== 'min' && key !== 'max');
    if (extra) throw new ActionError(`Input compatibility.${app} has ${JSON.stringify(extra)}; only min and max are allowed.`);
    const { min, max } = range;
    if (min !== undefined && (typeof min !== 'string' || !MIN_VERSION.test(min))) {
      throw new ActionError(`Input compatibility.${app}.min must be a version string such as "128.0", got ${JSON.stringify(min)}.`);
    }
    if (max !== undefined && (typeof max !== 'string' || !MAX_VERSION.test(max))) {
      throw new ActionError(`Input compatibility.${app}.max must be a version string such as "140.*" or "*", got ${JSON.stringify(max)}.`);
    }
    result[app] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  return result;
}

export const compatibilityApps = (wanted: Compatibility): App[] => (Array.isArray(wanted) ? wanted : (Object.keys(wanted) as App[]));

export function compatibilityMatches(wanted: Compatibility, current: Ranges): boolean {
  const apps = compatibilityApps(wanted);
  const held = Object.keys(current);
  if (held.length !== apps.length || !apps.every((app) => current[app] !== undefined)) return false;
  if (Array.isArray(wanted)) return true;
  return apps.every((app) => {
    const want = wanted[app]!;
    const have = current[app]!;
    return (want.min === undefined || want.min === have.min) && (want.max === undefined || want.max === have.max);
  });
}

export function describeCompatibility(ranges: Compatibility | Ranges): string {
  if (Array.isArray(ranges)) return ranges.join(' and ');
  const parts = Object.entries(ranges).map(([app, range]) => {
    if (range.min && range.max) return `${app} ${range.min} to ${range.max}`;
    if (range.min) return `${app} from ${range.min}`;
    if (range.max) return `${app} up to ${range.max}`;
    return app;
  });
  return parts.length > 0 ? parts.join(', ') : 'no application';
}
