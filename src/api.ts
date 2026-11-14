import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { accessToken, envCredential } from './auth.ts';
import { USER_AGENT } from './config.ts';
import { CliError, EXIT, type ErrorDetails, exitCodeFor } from './errors.ts';

/** Calls to MakeMidas's /api/v1 with the stored token or an API key. */

export interface Output {
  status: 'running' | 'done' | 'failed';
  /** Signed link, valid for an hour. */
  url?: string;
}

export interface Generation {
  id: string;
  kind: 'image' | 'video';
  model: string;
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
  aspectRatios: string[];
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
      maxReferences: number;
      credits: { resolution: string; credits: number }[];
      creditsPerReference?: number;
    })
  | (ModelBase & {
      kind: 'video';
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
  /** The request with every default filled in. */
  request: {
    kind: 'image' | 'video';
    model: string;
    aspectRatio: string;
    resolution: string | null;
    count: number;
    duration?: number;
    frameMode?: string;
    audio?: boolean;
  };
  /** When not affordable: the cheapest model whose default fits. */
  suggestedModel?: string;
}

export interface GenerationInput {
  kind: 'image' | 'video';
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  referenceIds?: string[];
  enhance?: boolean;
  style?: string;
  duration?: number;
  frameMode?: string;
  audio?: boolean;
  quotedCredits?: number;
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

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
        },
        body:
          opts.form ??
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

  async models(kind?: 'image' | 'video'): Promise<Model[]> {
    return (await this.json<{ models: Model[] }>('/models', { query: { kind } }))
      .models;
  }

  /** One model; ids hold a slash, which is sent encoded. */
  modelDetails(id: string) {
    return this.json<ModelDetails>(`/models/${encodeURIComponent(id)}`);
  }

  /** Upload a local image (or one downloaded from a URL) as a reference. */
  async upload(source: string): Promise<string> {
    let bytes: Uint8Array<ArrayBuffer>;
    let type: string | undefined;
    let name: string;
    if (/^https?:\/\//i.test(source)) {
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

  async list(query: { limit?: number; before?: string }) {
    return (
      await this.json<{ generations: Generation[] }>('/generations', { query })
    ).generations;
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
