import { parseArgs } from 'node:util';
import type {
  AudioTask,
  EditTask,
  FilmSettings,
  GenerationInput,
  TranscriptFormat,
} from './api.ts';
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
        'max-credits': { type: 'string' },
        out: { type: 'string', short: 'o', default: '.' },
        'no-download': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        'no-wait': { type: 'boolean', default: false },
        timeout: { type: 'string', default: '15' },
        limit: { type: 'string', default: '20' },
        before: { type: 'string' },
        kind: { type: 'string' },
        lyrics: { type: 'string' },
        title: { type: 'string' },
        instrumental: { type: 'boolean', default: false },
        loop: { type: 'boolean', default: false },
        bpm: { type: 'string' },
        voice: { type: 'string' },
        delivery: { type: 'string' },
        speed: { type: 'string' },
        stability: { type: 'string' },
        language: { type: 'string' },
        format: { type: 'string' },
        scale: { type: 'string' },
        models: { type: 'string' },
        generation: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        seconds: { type: 'string' },
        brief: { type: 'string' },
        'text-model': { type: 'string' },
        'video-model': { type: 'string' },
        'frame-model': { type: 'string' },
        'speech-model': { type: 'string' },
        'music-model': { type: 'string' },
        'music-prompt': { type: 'string' },
        transition: { type: 'string' },
        brand: { type: 'string' },
        'clip-audio': { type: 'boolean', default: false },
        'no-write': { type: 'boolean', default: false },
        file: { type: 'string' },
        pieces: { type: 'boolean', default: false },
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

export function numberOption(
  value: string | undefined,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n < min || n > max) {
    throw usageError(`--${name} must be a number from ${min} to ${max}.`);
  }
  return n;
}

type Values = Parsed['values'];

/** Options set on the command line, by name (booleans only when true). */
function given(v: Values, names: string[]): string[] {
  return names.filter((name) => {
    const value = (v as Record<string, unknown>)[name];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
  });
}

/** Refuse options that belong to another command. */
function refuse(v: Values, names: string[], command: string): void {
  const wrong = given(v, names);
  if (wrong.length) {
    throw usageError(
      `${wrong.map((name) => `--${name}`).join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not for \`${command}\`.`
    );
  }
}

const VISUAL_OPTIONS = [
  'aspect',
  'resolution',
  'count',
  'style',
  'enhance',
  'ref',
  'frame-mode',
  'audio',
];
const MUSIC_OPTIONS = ['lyrics', 'title', 'instrumental'];
const SFX_OPTIONS = ['loop', 'bpm'];
const SPEECH_OPTIONS = ['voice', 'delivery', 'speed', 'stability', 'language'];

function quotedCredits(v: Values): number | undefined {
  return intOption(v['quoted-credits'], 'quoted-credits', 0, 1_000_000);
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
  refuse(
    v,
    [...MUSIC_OPTIONS, ...SFX_OPTIONS, ...SPEECH_OPTIONS, 'scale', 'format'],
    kind
  );
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
  const quoted = quotedCredits(v);
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

/** The `makemidas music|sfx|speech` command each audio task is run with. */
export const AUDIO_COMMANDS: Record<AudioTask, string> = {
  music: 'music',
  sfx: 'sfx',
  speech: 'speech',
};

/** A `makemidas music|sfx|speech` request: kind audio with its task. */
export function audioInput(
  task: AudioTask,
  prompt: string | undefined,
  v: Values
): GenerationInput {
  const command = AUDIO_COMMANDS[task];
  if (!prompt?.trim()) {
    throw usageError(
      task === 'speech'
        ? 'Give the text to speak: `makemidas speech "Welcome back."`.'
        : `Give a prompt: \`makemidas ${command} "${task === 'music' ? 'lo-fi beat for studying' : 'a door creaking open'}"\`.`
    );
  }
  const others: string[] = [...VISUAL_OPTIONS, 'scale', 'format'];
  if (task !== 'music') others.push(...MUSIC_OPTIONS);
  if (task !== 'sfx') others.push(...SFX_OPTIONS);
  if (task !== 'speech') others.push(...SPEECH_OPTIONS);
  // Only music models list track lengths; sound effects set their own.
  if (task !== 'music') others.push('duration');
  refuse(v, others, command);
  const input: GenerationInput = {
    kind: 'audio',
    task,
    // A voiceover reads the text as written; prompts are trimmed.
    prompt: task === 'speech' ? prompt : prompt.trim(),
    ...(v.model ? { model: v.model } : {}),
  };
  if (task === 'music') {
    if (v.lyrics !== undefined) input.lyrics = v.lyrics;
    if (v.title !== undefined) input.title = v.title;
    if (v.instrumental) input.instrumental = true;
    if (v.lyrics !== undefined && v.instrumental) {
      throw usageError('--lyrics and --instrumental do not go together.');
    }
  }
  if (task === 'music') {
    const seconds = intOption(v.duration, 'duration', 1, 240);
    if (seconds) input.durationSeconds = seconds;
  }
  if (task === 'sfx') {
    if (v.loop) input.loop = true;
    const bpm = intOption(v.bpm, 'bpm', 40, 240);
    if (bpm !== undefined) input.bpm = bpm;
  }
  if (task === 'speech') {
    if (v.delivery !== undefined && (v.speed !== undefined || v.stability !== undefined)) {
      throw usageError(
        '--delivery is for Gemini TTS models, --speed and --stability for ElevenLabs models; use one or the other.'
      );
    }
    if (v.voice) input.voice = v.voice;
    if (v.delivery !== undefined) input.delivery = v.delivery;
    const speed = numberOption(v.speed, 'speed', 0.7, 1.2);
    if (speed !== undefined) input.speed = speed;
    const stability = numberOption(v.stability, 'stability', 0, 1);
    if (stability !== undefined) input.stability = stability;
    if (v.language) input.language = v.language;
  }
  const quoted = quotedCredits(v);
  if (quoted !== undefined) input.quotedCredits = quoted;
  return input;
}

export const DEFAULT_TRANSCRIPTION_MODEL = 'openai/whisper-large-v2';
const TRANSCRIPT_FORMATS: TranscriptFormat[] = ['txt', 'srt', 'vtt', 'json'];

/** The one file or link a `transcribe`/`remove-bg`/`upscale…` command takes. */
export function sourceArg(rest: string[], command: string, what: string): string {
  if (rest.length !== 1 || !rest[0].trim()) {
    throw usageError(`Give one ${what}: \`makemidas ${command} <file-or-url>\`.`);
  }
  return rest[0];
}

/** A `makemidas transcribe` request, without the fileId the upload returns. */
export function transcriptionInput(v: Values): {
  input: GenerationInput;
  format: TranscriptFormat;
} {
  refuse(
    v,
    [
      ...VISUAL_OPTIONS,
      ...MUSIC_OPTIONS.filter((name) => name !== 'title'),
      ...SFX_OPTIONS,
      ...SPEECH_OPTIONS,
      'duration',
      'scale',
    ],
    'transcribe'
  );
  const format = (v.format ?? 'txt').toLowerCase() as TranscriptFormat;
  if (!TRANSCRIPT_FORMATS.includes(format)) {
    throw usageError('--format must be txt, srt, vtt or json.');
  }
  const input: GenerationInput = {
    kind: 'transcription',
    model: v.model ?? DEFAULT_TRANSCRIPTION_MODEL,
    ...(v.title !== undefined ? { title: v.title } : {}),
  };
  const quoted = quotedCredits(v);
  if (quoted !== undefined) input.quotedCredits = quoted;
  return { input, format };
}

/** The `makemidas …` command that runs each edit task. */
export const EDIT_COMMANDS: Record<EditTask, string> = {
  'remove-background': 'remove-bg',
  'upscale-image': 'upscale',
  'upscale-video': 'upscale-video',
};

const VIDEO_UPSCALE_RESOLUTIONS = ['1080P', '2K', '4K'];

/** A `makemidas remove-bg|upscale|upscale-video` request (kind edit). */
export function editInput(task: EditTask, v: Values): GenerationInput {
  const command = EDIT_COMMANDS[task];
  const others = [
    ...VISUAL_OPTIONS.filter((name) => name !== 'resolution'),
    ...MUSIC_OPTIONS,
    ...SFX_OPTIONS,
    ...SPEECH_OPTIONS,
    'duration',
    'format',
  ];
  if (task !== 'upscale-image') others.push('scale');
  if (task !== 'upscale-video') others.push('resolution');
  refuse(v, others, command);
  const input: GenerationInput = {
    kind: 'edit',
    task,
    ...(v.model ? { model: v.model } : {}),
  };
  if (task === 'upscale-image' && v.scale !== undefined) {
    const scale = Number(v.scale.replace(/x$/i, ''));
    if (![1, 2, 4, 8].includes(scale)) {
      throw usageError('--scale must be 1, 2, 4 or 8.');
    }
    input.upscaleFactor = scale;
  }
  if (task === 'upscale-video' && v.resolution !== undefined) {
    const resolution = v.resolution.toUpperCase();
    if (!VIDEO_UPSCALE_RESOLUTIONS.includes(resolution)) {
      throw usageError('--resolution must be 1080P, 2K or 4K.');
    }
    input.resolution = resolution;
  }
  const quoted = quotedCredits(v);
  if (quoted !== undefined) input.quotedCredits = quoted;
  return input;
}

/** `--models a,b[,c,d]` for `makemidas compare`. */
export function compareModels(value: string | undefined): string[] {
  const models = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (models.length < 2 || models.length > 4) {
    throw usageError('Give 2 to 4 image models: `--models a,b[,c,d]`.');
  }
  if (new Set(models).size !== models.length) {
    throw usageError('--models must be different models.');
  }
  return models;
}

export function compareOptions(v: Values): void {
  refuse(
    v,
    [
      'model',
      'resolution',
      'count',
      'style',
      'enhance',
      'frame-mode',
      'audio',
      'duration',
      ...MUSIC_OPTIONS,
      ...SFX_OPTIONS,
      ...SPEECH_OPTIONS,
      'scale',
      'format',
    ],
    'compare'
  );
}

const FEEDBACK_KINDS = ['bug', 'feature', 'praise', 'other'] as const;

export function feedbackKind(value: string | undefined): (typeof FEEDBACK_KINDS)[number] {
  const kind = value ?? 'other';
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    throw usageError('--kind must be bug, feature, praise or other.');
  }
  return kind as (typeof FEEDBACK_KINDS)[number];
}

// ---------------------------------------------------------------- films

const TRANSITIONS = ['cut', 'fade', 'crossfade'] as const;

/**
 * Film settings from the command line. `none` turns music or the brand off;
 * a voice of `default` uses the voiceover model's own.
 */
export function filmSettings(v: Values): Partial<FilmSettings> {
  const settings: Partial<FilmSettings> = {};
  if (v.aspect) settings.aspectRatio = v.aspect;
  if (v.resolution) settings.resolution = v.resolution;
  if (v['text-model']) settings.textModel = v['text-model'];
  if (v['video-model']) settings.videoModel = v['video-model'];
  if (v['frame-model']) settings.frameModel = v['frame-model'];
  if (v['speech-model']) settings.speechModel = v['speech-model'];
  if (v.voice) settings.voice = v.voice === 'default' ? null : v.voice;
  if (v['music-model']) {
    settings.musicModel = v['music-model'] === 'none' ? null : v['music-model'];
  }
  if (v['music-prompt']) settings.musicPrompt = v['music-prompt'];
  if (v.brand) settings.brandId = v.brand === 'none' ? null : v.brand;
  if (v['clip-audio']) settings.clipAudio = true;
  if (v.transition) {
    if (!(TRANSITIONS as readonly string[]).includes(v.transition)) {
      throw usageError(`--transition must be ${TRANSITIONS.join(', ')}.`);
    }
    settings.transition = v.transition as FilmSettings['transition'];
  }
  return settings;
}

/** About how long the film should be, in seconds. */
export function filmSeconds(v: Values): number | undefined {
  return intOption(v.seconds, 'seconds', 10, 120);
}
