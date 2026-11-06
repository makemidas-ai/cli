import { parseArgs } from 'node:util';
import type { GenerationInput } from './api.ts';
import { CliError, EXIT } from './errors.ts';

export const usageError = (message: string) =>
  new CliError(`${message}\nRun \`makemidas --help\` for usage.`, EXIT.USAGE, 'usage');

export function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        'base-url': { type: 'string' },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        'no-browser': { type: 'boolean', default: false },
        model: { type: 'string', short: 'm' },
        aspect: { type: 'string', short: 'a' },
        resolution: { type: 'string', short: 'r' },
        count: { type: 'string', short: 'n' },
        style: { type: 'string' },
        enhance: { type: 'boolean', default: false },
        ref: { type: 'string', multiple: true, default: [] },
        duration: { type: 'string', short: 'd' },
        'frame-mode': { type: 'string' },
        audio: { type: 'boolean', default: false },
        'quoted-credits': { type: 'string' },
        out: { type: 'string', short: 'o', default: '.' },
        'no-download': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        'no-wait': { type: 'boolean', default: false },
        timeout: { type: 'string', default: '15' },
        limit: { type: 'string', default: '20' },
        before: { type: 'string' },
        kind: { type: 'string' },
      },
    });
  } catch (error) {
    throw usageError((error as Error).message);
  }
}

export type Parsed = ReturnType<typeof parse>;

export function intOption(
  value: string | undefined,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`--${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

/** The generation request a `makemidas image|video` command line asks for. */
export function generationInput(
  kind: 'image' | 'video',
  prompt: string | undefined,
  v: Parsed['values']
): GenerationInput {
  if (!prompt?.trim()) {
    throw usageError(`Give a prompt: \`makemidas ${kind} "a fox in the snow"\`.`);
  }
  if (kind === 'image' && (v.duration || v.audio || v['frame-mode'])) {
    throw usageError('--duration, --audio and --frame-mode are for videos.');
  }
  const input: GenerationInput = {
    kind,
    prompt: prompt.trim(),
    ...(v.model ? { model: v.model } : {}),
    ...(v.aspect ? { aspectRatio: v.aspect } : {}),
    ...(v.resolution ? { resolution: v.resolution } : {}),
    ...(v.style ? { style: v.style } : {}),
    ...(v.enhance ? { enhance: true } : {}),
  };
  const count = intOption(v.count, 'count', 1, 4);
  if (count) input.count = count;
  const quoted = intOption(v['quoted-credits'], 'quoted-credits', 0, 1_000_000);
  if (quoted !== undefined) input.quotedCredits = quoted;
  if (kind === 'video') {
    const duration = intOption(v.duration, 'duration', 1, 30);
    if (duration) input.duration = duration;
    if (v.audio) input.audio = true;
    if (v['frame-mode']) {
      if (!['none', 'first', 'first_last', 'reference'].includes(v['frame-mode'])) {
        throw usageError('--frame-mode must be none, first, first_last or reference.');
      }
      input.frameMode = v['frame-mode'];
    }
  }
  return input;
}
