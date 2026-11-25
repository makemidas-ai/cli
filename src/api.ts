import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { accessToken, envCredential } from './auth.ts';
import { USER_AGENT } from './config.ts';
import { CliError, EXIT, type ErrorDetails, exitCodeFor } from './errors.ts';

/** Calls to MakeMidas's /api/v1 with the stored token or an API key. */

export type Kind = 'image' | 'video' | 'audio' | 'transcription' | 'edit';
export const KINDS: readonly Kind[] = [
  'image',
  'video',
  'audio',
  'transcription',
  'edit',
];

export type TranscriptFormat = 'txt' | 'srt' | 'vtt' | 'json';

export interface Output {
  status: 'running' | 'done' | 'failed';
  /** Signed link, valid for an hour. */
  url?: string;
  /** Audio only: cover art the model made. */
  coverUrl?: string;
  /** Transcription only: the start of the text and its facts. */
  transcript?: {
    preview?: string;
    durationSeconds?: number;
    speakers?: number;
    language?: string;
  };
  /** Transcription only: a signed download link for each format. */
  downloads?: Partial<Record<TranscriptFormat, string>>;
}

export interface Generation {
  id: string;
  kind: Kind;
  model: string;
  modelLabel?: string;
  prompt: string;
  params: Record<string, unknown>;
  count: number;
  credits: number;
  status: 'running' | 'done' | 'failed';
  watermarked: boolean;
  outputs: Output[];
  error?: string;
  createdAt: string;
  webUrl: string;
}

export interface Credits {
  balance: number;
  expiring: { amount: number; expiresAt: string }[];
  plan: string | null;
  paid: boolean;
  watermarked: boolean;
  concurrency: number;
  maxOutputs: number;
}

interface ModelBase {
  id: string;
  label: string;
  tier: 'free' | 'paid';
  /** Images and videos only. */
  aspectRatios?: string[];
  /** Present on `GET /models/{id}`; the list may leave these out. */
  family?: string;
  /** Fraction off the list price, 0 when none. */
  discount?: number;
  resolutions?: string[];
  defaultResolution?: string | null;
}

export type Model =
  | (ModelBase & {
      kind: 'image';
      aspectRatios: string[];
      maxReferences: number;
      credits: { resolution: string; credits: number }[];
      creditsPerReference?: number;
    })
  | (ModelBase & {
      kind: 'video';
      aspectRatios: string[];
      durations: number[];
      defaultDuration?: number;
      frameModes: string[];
      frameLimits?: Record<string, { min: number; max: number }>;
      audio: boolean;
      credits: {
        resolution: string;
        creditsPerSecond: number;
        creditsPerSecondWithAudio?: number;
      }[];
      creditsPerFrame?: number;
    })
  | (ModelBase & {
      kind: 'audio';
      task: 'music' | 'sfx' | 'speech';
      durations: number[];
      defaultDuration: number | null;
      lyrics: boolean;
      instrumental: boolean;
      loop: boolean;
      creditsPerTrack?: number;
      creditsPer1kChars?: number;
      maxChars?: number;
      voices?: { id: string; name: string; description: string }[];
      defaultVoice?: string;
      speedRange?: { min: number; max: number; default: number };
      maxDeliveryChars?: number;
      languages?: string[];
    })
  | (ModelBase & {
      kind: 'transcription';
      creditsPerHour: number;
      maxDurationSeconds: number;
      maxBytes: number;
      formats: string;
      speakers: boolean;
      languages: number;
      outputFormats: TranscriptFormat[];
    })
  | (ModelBase & {
      kind: 'edit';
      task: 'remove-background' | 'upscale-image' | 'upscale-video';
      input: string;
      limits: string;
      credits?: { resolution: string; credits: number }[];
      creditsPerSecond?: { resolution: string; creditsPerSecond: number }[];
      upscaleFactors?: number[];
    });

/** `GET /models/{id}`: the model and the smallest request for it. */
export interface ModelDetails {
  model: Model;
  example: Record<string, unknown>;
}

/** `POST /generations/estimate`: the price of a request, nothing charged. */
export interface Estimate {
  credits: number;
  listCredits: number;
  discount: number;
  balance: number;
  affordable: boolean;
  model: string;
  /**
   * The full request with every default filled in. Sent back to
   * `POST /generations` with `quotedCredits`, it runs at this price.
   */
  request: GenerationInput & {
    prompt: string;
    model: string;
    count: number;
    referenceIds: string[];
    enhance: boolean;
  };
  /** When not affordable: the cheapest model whose default fits. */
  suggestedModel?: string;
}

export type AudioTask = 'music' | 'sfx' | 'speech';
export type EditTask = 'remove-background' | 'upscale-image' | 'upscale-video';

export interface GenerationInput {
  kind: Kind;
  /** What to make; the text to speak for a voiceover; none for edits and transcripts. */
  prompt?: string;
  model?: string;
  /** Audio and edits. */
  task?: AudioTask | EditTask;
  /** Transcription and video upscale: an id from audio- or video-uploads. */
  fileId?: string;
  aspectRatio?: string;
  /** Null for a model without resolution choices. */
  resolution?: string | null;
  count?: number;
  referenceIds?: string[];
  enhance?: boolean;
  style?: string;
  duration?: number;
  frameMode?: string;
  audio?: boolean;
  /** Music: lyrics, title (transcription: its name), no vocals, length. */
  lyrics?: string;
  title?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  /** Sound effects. */
  loop?: boolean;
  bpm?: number;
  /** Voiceovers. */
  voice?: string;
  delivery?: string;
  speed?: number;
  stability?: number;
  language?: string;
  /** Image upscale: 1, 2, 4 or 8. */
  upscaleFactor?: number;
  /** Images and videos: a saved brand's id; its guidelines join the prompt. */
  brandId?: string;
  /** With brandId, images: also send the brand's first logo. */
  brandLogo?: boolean;
  /** Images and videos: a saved character's id; its pictures are references. */
  characterId?: string;
  quotedCredits?: number;
}

/** `POST /audio-uploads` and `POST /video-uploads`: the file, measured and priced. */
export interface MediaUpload {
  fileId: string;
  fileName?: string;
  durationSeconds: number;
  contentType?: string;
  size?: number;
  /** Transcribing it with the default model, or upscaling it to 2K. */
  credits: number;
  /** Video uploads: the upscale price for each output box. */
  creditsByResolution?: Record<string, number>;
}

export interface CompareInput {
  prompt: string;
  models: string[];
  aspectRatio?: string;
  referenceIds?: string[];
  quotedCredits?: number;
}

/** `POST /generations/compare`: one image generation per model. */
export interface Comparison {
  credits: number;
  generations: Generation[];
  failed: {
    model: string;
    error: { code: string; message: string } & ErrorDetails;
  }[];
}

export interface FeedbackInput {
  kind: 'bug' | 'feature' | 'praise' | 'other';
  message: string;
  generationId?: string;
}

/** `GET /credits/purchase-link`: where to buy, and what is on sale. */
export interface PurchaseLink {
  url: string;
  plansUrl: string;
  packsUrl: string;
  billingUrl: string;
  purchasable: boolean;
  balance: number;
  plan: string | null;
  plans: {
    id: string;
    name: string;
    priceUsd: number;
    interval: 'month';
    monthlyCredits: number;
    concurrency: number;
    maxOutputs: number;
    popular: boolean;
    current: boolean;
  }[];
  packs: {
    id: string;
    priceUsd: number;
    credits: number;
    subscriberCredits: number;
    popular: boolean;
  }[];
}

// ---------------------------------------------------------------- films

export type FilmStage = 'draft' | 'storyboard' | 'frames' | 'film' | 'assembled';
export type FilmNext =
  | 'write_storyboard'
  | 'approve_frames'
  | 'making_frames'
  | 'approve_film'
  | 'making_film'
  | 'assemble'
  | 'assembling'
  | 'done'
  | 'paused';
export type FilmPart = 'frame' | 'clip' | 'voice';

export interface FilmPiece {
  generationId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  /** Signed for an hour; get the project again for fresh links. */
  url?: string;
  error?: string;
}

export interface FilmShot {
  id: string;
  position: number;
  description: string;
  prompt: string;
  camera: string | null;
  duration: number;
  characterId: string | null;
  voiceover: string | null;
  assetIds: string[];
  error: string | null;
  frame: FilmPiece | null;
  clip: FilmPiece | null;
  voice: FilmPiece | null;
  /** Credits each step costs at today's prices. */
  credits: { frame: number; clip: number; voice: number };
}

export interface FilmSettings {
  aspectRatio: string;
  videoModel: string;
  resolution: string;
  frameModel: string;
  clipAudio: boolean;
  speechModel: string;
  voice: string | null;
  musicModel: string | null;
  musicPrompt: string | null;
  textModel: string;
  brandId: string | null;
  characterIds: string[];
  transition: 'cut' | 'fade' | 'crossfade';
}

export interface FilmTimeline {
  aspectRatio: string;
  resolution: string;
  transition: string;
  seconds: number;
  clips: { shotId: string; start: number; duration: number; url: string }[];
  voiceover: { shotId: string; start: number; url: string }[];
  music: { url: string } | null;
  howTo: string;
}

/** `GET /films/{id}`: a film project with signed links to its pieces. */
export interface Film {
  id: string;
  title: string;
  brief: string;
  stage: FilmStage;
  settings: FilmSettings;
  script: string | null;
  pausedReason: string | null;
  shots: FilmShot[];
  music: FilmPiece | null;
  assembly: FilmPiece | null;
  /** Credits the next approval asks for (frames or film), 0 when none. */
  pendingCredits: number;
  next: FilmNext;
  seconds: number;
  /** The assembled film, signed for an hour. */
  filmUrl: string | null;
  /** Once every clip is made: everything needed to assemble it yourself. */
  timeline: FilmTimeline | null;
  webUrl: string;
}

export interface FilmSummary {
  id: string;
  title: string;
  stage: FilmStage;
  shots: number;
  seconds: number;
  updatedAt: string;
  webUrl: string;
}

/** A shot as `PATCH /films/{id}` takes it; one without `id` is new. */
export interface FilmShotInput {
  id?: string;
  description?: string;
  prompt: string;
  camera?: string | null;
  duration: number;
  characterId?: string | null;
  voiceover?: string | null;
  assetIds?: string[];
}

export interface FilmUpdate {
  title?: string;
  brief?: string;
  script?: string;
  settings?: Partial<FilmSettings>;
  shots?: FilmShotInput[];
}

export interface Brand {
  id: string;
  name: string;
  isDefault: boolean;
  colors: { name?: string; hex: string; role: string }[];
  fonts: { name: string; role: string }[];
  tone: string | null;
  dos: string | null;
  donts: string | null;
  logos: { id: string }[];
  styleImages: { id: string }[];
  /** The brand as prompt text: what the server adds for it. */
  guidelines: string;
}

export interface Character {
  id: string;
  name: string;
  description: string | null;
  imageCount: number;
}

export interface Asset {
  id: string;
  kind: 'image' | 'video' | 'audio';
  name: string;
  tags: string[];
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  createdAt: string;
}

export type MediaUploadKind = 'audio' | 'video';

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  /** A raw request body, sent with `headers` (Content-Type and the like). */
  body?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** What audio- and video-uploads accept, by file extension. */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};
const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
  ...VIDEO_TYPES,
};
const MEDIA_UPLOADS: Record<
  MediaUploadKind,
  { path: string; types: Record<string, string>; what: string }
> = {
  audio: {
    path: '/audio-uploads',
    types: AUDIO_TYPES,
    what: 'MP3, WAV, M4A, AAC, FLAC, OGG, Opus, WEBM, MP4 or MOV',
  },
  video: { path: '/video-uploads', types: VIDEO_TYPES, what: 'MP4 or MOV' },
};

const isUrl = (source: string) => /^https?:\/\//i.test(source);

export class Api {
  readonly baseUrl: string;
  /** Overridable in tests. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async send(
    path: string,
    opts: RequestOptions,
    forceRefresh: boolean
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = await accessToken(this.baseUrl, forceRefresh);
    try {
      return await this.fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          ...(opts.json !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...opts.headers,
        },
        body:
          opts.form ??
          opts.body ??
          (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      });
    } catch (error) {
      throw new CliError(
        `Can't reach ${this.baseUrl}: ${(error as Error).message}`,
        EXIT.NETWORK,
        'NETWORK'
      );
    }
  }

  /** The raw response; API errors are thrown as CliError. */
  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    let res = await this.send(path, opts, false);
    // The token may have been revoked or expired early: refresh once.
    if (res.status === 401 && !envCredential() && !opts.form) {
      res = await this.send(path, opts, true);
    }
    if (res.ok) return res;
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    let credits: number | undefined;
    const details: ErrorDetails = {};
    try {
      const body = (await res.json()) as {
        error?: {
          code?: string;
          message?: string;
          credits?: number;
        } & ErrorDetails;
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      credits = body.error?.credits;
      if (typeof body.error?.retryable === 'boolean') {
        details.retryable = body.error.retryable;
      }
      if (typeof body.error?.requiresPromptRevision === 'boolean') {
        details.requiresPromptRevision = body.error.requiresPromptRevision;
      }
      if (typeof body.error?.suggestedModel === 'string') {
        details.suggestedModel = body.error.suggestedModel;
      }
    } catch {}
    if (code === 'price_changed' && credits !== undefined) {
      message = `The price is now ${credits} credits; nothing was charged. Run again with --quoted-credits ${credits}.`;
    }
    throw new CliError(message, exitCodeFor(code, res.status), code, details);
  }

  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await (await this.request(path, opts)).json()) as T;
  }

  me() {
    return this.json<{
      id: string;
      email: string;
      plan: string | null;
      paid: boolean;
      via: string;
    }>('/me');
  }

  credits() {
    return this.json<Credits>('/credits');
  }

  async models(kind?: Kind): Promise<Model[]> {
    return (await this.json<{ models: Model[] }>('/models', { query: { kind } }))
      .models;
  }

  /** One model; ids hold a slash, which is sent encoded. */
  modelDetails(id: string) {
    return this.json<ModelDetails>(`/models/${encodeURIComponent(id)}`);
  }

  async brands(): Promise<Brand[]> {
    return (await this.json<{ brands: Brand[] }>('/brands')).brands;
  }

  /** One brand; `default` is the default brand (or the only one). */
  brand(id: string) {
    return this.json<Brand>(`/brands/${encodeURIComponent(id)}`);
  }

  async characters(): Promise<Character[]> {
    return (await this.json<{ characters: Character[] }>('/characters')).characters;
  }

  /** A page of the asset library, newest first. */
  assets(query: { q?: string; kind?: string; limit?: number }) {
    return this.json<{ assets: Asset[]; nextCursor: string | null }>('/assets', {
      query,
    });
  }

  /**
   * Upload a local image (or one downloaded from a URL) as a reference;
   * `asset:<id>` uses a file from the asset library.
   */
  async upload(source: string): Promise<string> {
    if (source.startsWith('asset:')) {
      const { id } = await this.json<{ id: string }>('/uploads', {
        method: 'POST',
        json: { assetId: source.slice('asset:'.length) },
      });
      return id;
    }
    let bytes: Uint8Array<ArrayBuffer>;
    let type: string | undefined;
    let name: string;
    if (isUrl(source)) {
      const res = await this.fetchImpl(source).catch(() => null);
      if (!res?.ok) {
        throw new CliError(`Could not download ${source}`, EXIT.USAGE, 'invalid_file');
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      type = res.headers.get('content-type')?.split(';')[0].trim();
      name = basename(new URL(source).pathname) || 'image';
    } else {
      try {
        bytes = new Uint8Array(await readFile(source));
      } catch {
        throw new CliError(`Can't read ${source}`, EXIT.USAGE, 'invalid_file');
      }
      type = CONTENT_TYPES[extname(source).toLowerCase()];
      name = basename(source);
    }
    if (!type || !Object.values(CONTENT_TYPES).includes(type)) {
      throw new CliError(
        `${source}: reference images must be JPG, PNG or WebP.`,
        EXIT.USAGE,
        'invalid_file'
      );
    }
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    const { id } = await this.json<{ id: string }>('/uploads', {
      method: 'POST',
      form,
    });
    return id;
  }

  /**
   * Upload audio or video to transcribe (`audio`), or a video to upscale
   * (`video`): a local file goes as the raw body, a link as `{ url }` for
   * the server to download.
   */
  async mediaUpload(kind: MediaUploadKind, source: string): Promise<MediaUpload> {
    const { path, types, what } = MEDIA_UPLOADS[kind];
    if (isUrl(source)) {
      return this.json<MediaUpload>(path, {
        method: 'POST',
        json: { url: source },
      });
    }
    const type = types[extname(source).toLowerCase()];
    if (!type) {
      throw new CliError(
        `${source}: upload ${what} files.`,
        EXIT.USAGE,
        'invalid_file'
      );
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await readFile(source));
    } catch {
      throw new CliError(`Can't read ${source}`, EXIT.USAGE, 'invalid_file');
    }
    return this.json<MediaUpload>(path, {
      method: 'POST',
      body: bytes,
      headers: {
        'Content-Type': type,
        'Content-Length': String(bytes.byteLength),
        'X-File-Name': encodeURIComponent(basename(source)),
      },
    });
  }

  generate(input: GenerationInput) {
    return this.json<Generation>('/generations', {
      method: 'POST',
      json: input,
    });
  }

  /** Price a request without charging or creating anything. */
  estimate(input: GenerationInput) {
    return this.json<Estimate>('/generations/estimate', {
      method: 'POST',
      json: input,
    });
  }

  generation(id: string, waitSeconds = 0) {
    return this.json<Generation>(`/generations/${encodeURIComponent(id)}`, {
      query: { wait: waitSeconds || undefined },
    });
  }

  /** Run one prompt on 2-4 image models at once. */
  compare(input: CompareInput) {
    return this.json<Comparison>('/generations/compare', {
      method: 'POST',
      json: input,
    });
  }

  /** Delete a finished or failed generation and its files. */
  deleteGeneration(id: string) {
    return this.json<{ id: string; deleted: true }>(
      `/generations/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  }

  feedback(input: FeedbackInput) {
    return this.json<{ received: true }>('/feedback', {
      method: 'POST',
      json: input,
    });
  }

  purchaseLink() {
    return this.json<PurchaseLink>('/credits/purchase-link');
  }

  async list(query: { limit?: number; before?: string }) {
    return (
      await this.json<{ generations: Generation[] }>('/generations', { query })
    ).generations;
  }

  // ---------------------------------------------------------------- films

  async films(): Promise<FilmSummary[]> {
    return (await this.json<{ films: FilmSummary[] }>('/films')).films;
  }

  film(id: string) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}`);
  }

  /** A new project from a brief; nothing is charged. */
  createFilm(input: {
    brief: string;
    title?: string;
    settings?: Partial<FilmSettings>;
  }) {
    return this.json<Film>('/films', { method: 'POST', json: input });
  }

  updateFilm(id: string, input: FilmUpdate) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: input,
    });
  }

  async deleteFilm(id: string): Promise<void> {
    await this.request(`/films/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** The most writing the storyboard can cost. */
  storyboardQuote(id: string, targetSeconds?: number) {
    return this.json<{ credits: number; model: string }>(
      `/films/${encodeURIComponent(id)}/storyboard`,
      { query: { targetSeconds } }
    );
  }

  writeStoryboard(
    id: string,
    input: { targetSeconds?: number; brief?: string; quotedCredits?: number }
  ) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}/storyboard`, {
      method: 'POST',
      json: input,
    });
  }

  approveFilm(id: string, input: { stage: 'frames' | 'film'; quotedCredits: number }) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      json: input,
    });
  }

  redoShot(id: string, shotId: string, input: { part: FilmPart; quotedCredits: number }) {
    return this.json<Film>(
      `/films/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/redo`,
      { method: 'POST', json: input }
    );
  }

  resumeFilm(id: string) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
  }

  assembleFilm(id: string) {
    return this.json<Film>(`/films/${encodeURIComponent(id)}/assemble`, {
      method: 'POST',
    });
  }

  /** Download a signed output link. */
  async download(url: string): Promise<{ bytes: Uint8Array; type: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (error) {
      throw new CliError(
        `Download failed: ${(error as Error).message}`,
        EXIT.NETWORK,
        'NETWORK'
      );
    }
    if (!res.ok) {
      throw new CliError(
        `Download failed (${res.status}); links last an hour, run \`makemidas get <id>\` for fresh ones.`,
        EXIT.NETWORK,
        'NETWORK'
      );
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      type: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
