import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type {
  Api,
  Comparison,
  Estimate,
  FeedbackInput,
  Generation,
  GenerationInput,
  Kind,
  MediaUploadKind,
  Model,
  TranscriptFormat,
} from './api.ts';
import { envCredential, login } from './auth.ts';
import { deleteProfile, loadProfile, saveProfile } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { formatBytes, log, print, printJson, warn } from './output.ts';

export interface Globals {
  json: boolean;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'application/json': 'json',
  'text/plain': 'txt',
};

/** Where a generation's file goes: `<dir>/makemidas-<id>-<n>.<ext>`. */
function outputPath(dir: string, generation: Generation, n: number, ext: string) {
  return join(dir, `makemidas-${generation.id.slice(0, 8)}-${n}.${ext}`);
}

export async function writeOutput(
  file: string,
  bytes: Uint8Array,
  force: boolean
): Promise<boolean> {
  if (existsSync(file) && !force) {
    warn(`${file} exists; skipped (use --force to overwrite).`);
    return false;
  }
  await writeFile(file, bytes);
  log(`Saved ${file} (${formatBytes(bytes.byteLength)})`);
  return true;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export async function authLogin(
  api: Api,
  g: Globals,
  opts: { browser: boolean }
): Promise<void> {
  const profile = await login(api.baseUrl, opts);
  const me = await api.me();
  await saveProfile(api.baseUrl, { ...profile, email: me.email });
  if (g.json) printJson({ signedIn: true, ...me, baseUrl: api.baseUrl });
  else print(`Signed in as ${me.email} (plan: ${me.plan ?? 'free'}).`);
}

export async function authStatus(api: Api, g: Globals): Promise<void> {
  const profile = await loadProfile(api.baseUrl);
  if (!profile && !envCredential()) {
    if (g.json) printJson({ signedIn: false, baseUrl: api.baseUrl });
    throw new CliError(
      'Not signed in. Run `makemidas auth login`, or set MAKEMIDAS_API_KEY.',
      EXIT.AUTH,
      'unauthorized'
    );
  }
  const me = await api.me();
  if (g.json) printJson({ signedIn: true, ...me, baseUrl: api.baseUrl });
  else {
    print(
      `Signed in as ${me.email} (plan: ${me.plan ?? 'free'}, via ${me.via}) on ${api.baseUrl}.`
    );
  }
}

export async function authLogout(api: Api, g: Globals): Promise<void> {
  const profile = await loadProfile(api.baseUrl);
  if (profile && !envCredential()) {
    try {
      await api.request('/auth/revoke', { method: 'POST' });
    } catch (error) {
      log(`Could not revoke the token on the server: ${(error as Error).message}`);
    }
  }
  const removed = await deleteProfile(api.baseUrl);
  if (g.json) printJson({ signedOut: removed });
  else print(removed ? 'Signed out.' : 'Not signed in.');
}

// ---------------------------------------------------------------------------
// generate / get
// ---------------------------------------------------------------------------

export interface SaveOptions {
  /** Directory for downloads; null prints links only. */
  out: string | null;
  force: boolean;
}

export interface WaitOptions {
  wait: boolean;
  timeoutMin: number;
}

/** Save every finished output into `dir`; returns the file paths. */
async function saveOutputs(
  api: Api,
  generation: Generation,
  save: SaveOptions
): Promise<string[]> {
  if (!save.out) return [];
  const dir = resolve(save.out);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [index, output] of generation.outputs.entries()) {
    if (output.status !== 'done' || !output.url) continue;
    const { bytes, type } = await api.download(output.url);
    const ext = EXTENSIONS[type.split(';')[0].trim()] ?? 'bin';
    const file = outputPath(dir, generation, index + 1, ext);
    if (await writeOutput(file, bytes, save.force)) files.push(file);
  }
  return files;
}

/** Keep asking for a running generation until it finishes or time runs out. */
async function waitFor(
  api: Api,
  generation: Generation,
  timeoutMin: number
): Promise<Generation> {
  const deadline = Date.now() + timeoutMin * 60_000;
  let current = generation;
  while (current.status === 'running' && Date.now() < deadline) {
    log(`Rendering ${current.kind}… (${current.id})`);
    current = await api.generation(current.id, 40);
  }
  return current;
}

function report(
  g: Globals,
  generation: Generation,
  files: string[],
  links: string[] = generation.outputs.flatMap((o) => (o.url ? [o.url] : []))
): void {
  if (g.json) {
    printJson({ ...generation, files });
  } else {
    if (files.length) for (const file of files) print(file);
    else for (const link of links) print(link);
    log(
      `${generation.kind} ${generation.id}: ${generation.status}, ${generation.credits} credits${generation.watermarked ? ' (watermarked: no plan or credit pack)' : ''}.`
    );
  }
  if (generation.status === 'failed') {
    throw new CliError(
      generation.error ?? 'The model could not make this; credits were refunded.',
      EXIT.FAILED,
      'generation_failed'
    );
  }
  if (generation.status === 'running') {
    throw new CliError(
      `Still rendering. Run \`makemidas get ${generation.id} --wait\` later.`,
      EXIT.NOT_READY,
      'not_ready'
    );
  }
}

/** Upload each `--ref` and return the reference ids. */
async function uploadRefs(api: Api, refs: string[]): Promise<string[]> {
  const referenceIds: string[] = [];
  for (const ref of refs) {
    log(`Uploading ${ref}…`);
    referenceIds.push(await api.upload(ref));
  }
  return referenceIds;
}

/**
 * Price the request first and refuse when it costs more than `maxCredits`;
 * otherwise send the estimated request back with its price as
 * `quotedCredits`, so the server charges exactly that or nothing.
 */
async function quotedRequest(
  api: Api,
  input: GenerationInput,
  maxCredits: number
): Promise<GenerationInput> {
  const quote = await api.estimate(input);
  if (quote.credits > maxCredits) {
    throw new CliError(
      `This costs ${quote.credits} credits, over --max-credits ${maxCredits}. Nothing was charged.`,
      EXIT.CREDITS,
      'over_budget'
    );
  }
  if (!quote.affordable) {
    throw new CliError(
      `This costs ${quote.credits} credits and your balance is ${quote.balance}. Nothing was charged.`,
      EXIT.CREDITS,
      'insufficient_credits',
      quote.suggestedModel ? { suggestedModel: quote.suggestedModel } : {}
    );
  }
  log(`Quoted ${quote.credits} credits.`);
  return { ...quote.request, quotedCredits: quote.credits };
}

/** Upload a file or link to audio- or video-uploads; returns its fileId. */
async function uploadMedia(
  api: Api,
  kind: MediaUploadKind,
  source: string
): Promise<string> {
  // An id from an earlier upload (or estimate) is used as it is.
  if (UUID.test(source) && !existsSync(source)) return source;
  log(`Uploading ${source}…`);
  const upload = await api.mediaUpload(kind, source);
  log(`Uploaded ${upload.fileName ?? source}: ${formatSeconds(upload.durationSeconds)}.`);
  return upload.fileId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** A file to upload before the request: transcription audio or a video to upscale. */
export interface MediaSource {
  kind: MediaUploadKind;
  source: string;
}

/** Upload what the request needs and fill in referenceIds or fileId. */
async function prepare(
  api: Api,
  input: GenerationInput,
  refs: string[],
  media?: MediaSource
): Promise<GenerationInput> {
  const referenceIds = await uploadRefs(api, refs);
  const fileId = media ? await uploadMedia(api, media.kind, media.source) : undefined;
  // `--brand default` names the default brand; the API takes its id.
  const brandId =
    input.brandId === 'default' ? (await api.brand('default')).id : input.brandId;
  return {
    ...input,
    ...(brandId ? { brandId } : {}),
    // Images and videos always send the list; other kinds only when given.
    ...(input.kind === 'image' || input.kind === 'video' || referenceIds.length
      ? { referenceIds }
      : {}),
    ...(fileId ? { fileId } : {}),
  };
}

/** Upload, price when asked, start the generation and wait for it. */
async function start(
  api: Api,
  input: GenerationInput,
  refs: string[],
  wait: WaitOptions,
  maxCredits?: number,
  media?: MediaSource
): Promise<Generation> {
  const prepared = await prepare(api, input, refs, media);
  const request =
    maxCredits === undefined
      ? prepared
      : await quotedRequest(api, prepared, maxCredits);
  log(`Generating ${input.kind}…`);
  let generation = await api.generate(request);
  if (generation.status === 'running' && wait.wait) {
    generation = await waitFor(api, generation, wait.timeoutMin);
  }
  return generation;
}

export async function generate(
  api: Api,
  g: Globals,
  input: GenerationInput,
  refs: string[],
  save: SaveOptions,
  wait: WaitOptions,
  maxCredits?: number,
  media?: MediaSource
): Promise<void> {
  const generation = await start(api, input, refs, wait, maxCredits, media);
  const files = await saveOutputs(api, generation, save);
  report(g, generation, files);
}

// ---------------------------------------------------------------------------
// transcribe
// ---------------------------------------------------------------------------

/**
 * Upload the audio (or send its link), transcribe it, and save the
 * transcript in `format`. `save.out` of `-` prints the transcript itself.
 */
export async function transcribe(
  api: Api,
  g: Globals,
  input: GenerationInput,
  source: string,
  format: TranscriptFormat,
  save: SaveOptions,
  wait: WaitOptions,
  maxCredits?: number
): Promise<void> {
  if (save.out === '-' && g.json) {
    throw new CliError(
      '`--out -` prints the transcript itself; leave out --json.',
      EXIT.USAGE,
      'usage'
    );
  }
  const generation = await start(api, input, [], wait, maxCredits, {
    kind: 'audio',
    source,
  });
  const files: string[] = [];
  const links: string[] = [];
  for (const [index, output] of generation.outputs.entries()) {
    if (output.status !== 'done') continue;
    const link = output.downloads?.[format];
    if (!link) {
      if (output.url) {
        warn(`No ${format} download for this transcript; printing its JSON link.`);
        links.push(output.url);
      }
      continue;
    }
    links.push(link);
    if (!save.out) continue;
    const { bytes } = await api.download(link);
    if (save.out === '-') {
      process.stdout.write(bytes);
      continue;
    }
    const dir = resolve(save.out);
    await mkdir(dir, { recursive: true });
    const file = outputPath(dir, generation, index + 1, format);
    if (await writeOutput(file, bytes, save.force)) files.push(file);
  }
  if (save.out === '-') {
    report({ json: false }, generation, [], []);
    return;
  }
  report(g, generation, files, links);
}

export async function get(
  api: Api,
  g: Globals,
  id: string | undefined,
  save: SaveOptions,
  wait: WaitOptions
): Promise<void> {
  if (!id) {
    throw new CliError('Give a generation id: `makemidas get <id>`.', EXIT.USAGE, 'usage');
  }
  let generation = await api.generation(id);
  if (generation.status === 'running' && wait.wait) {
    generation = await waitFor(api, generation, wait.timeoutMin);
  }
  const files = await saveOutputs(api, generation, save);
  report(g, generation, files);
}

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

/** The settings a request resolved to, e.g. `16:9, 720p, 5s, audio`. */
function settings(request: Estimate['request']): string {
  const parts: string[] = [];
  if (request.task) parts.push(request.task);
  if (request.aspectRatio) parts.push(request.aspectRatio);
  if (request.resolution) parts.push(request.resolution);
  if (request.duration) parts.push(`${request.duration}s`);
  if (request.durationSeconds) parts.push(`${request.durationSeconds}s`);
  if (request.audio) parts.push('audio');
  if (request.frameMode && request.frameMode !== 'none') {
    parts.push(`frame mode ${request.frameMode}`);
  }
  if (request.upscaleFactor) parts.push(`${request.upscaleFactor}x`);
  if (request.voice) parts.push(`voice ${request.voice}`);
  if (request.instrumental) parts.push('instrumental');
  if (request.loop) parts.push('loop');
  if (request.kind === 'image' || request.kind === 'video') {
    parts.push(`${request.count} output${request.count === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

export async function estimate(
  api: Api,
  g: Globals,
  input: GenerationInput,
  refs: string[],
  command: string = input.kind,
  media?: MediaSource
): Promise<void> {
  const result = await api.estimate(await prepare(api, input, refs, media));
  if (g.json) {
    printJson(result);
    return;
  }
  const off =
    result.discount > 0
      ? ` (list ${result.listCredits}, ${Math.round(result.discount * 100)}% off)`
      : '';
  print(`${result.credits} credits${off}`);
  print(`Model: ${result.model}`);
  print(`Settings: ${settings(result.request)}`);
  print(
    `Balance: ${result.balance} credits, ${result.affordable ? 'affordable' : 'not enough'}`
  );
  if (!result.affordable && result.suggestedModel) {
    print(`Suggested model: ${result.suggestedModel} (fits your balance)`);
  }
  log(
    `Nothing was charged. Generate at this price with \`makemidas ${command}\` and the same options plus --max-credits ${result.credits}.`
  );
}

// ---------------------------------------------------------------------------
// list / credits / models
// ---------------------------------------------------------------------------

export async function list(
  api: Api,
  g: Globals,
  query: { limit: number; before?: string }
): Promise<void> {
  const generations = await api.list(query);
  if (g.json) {
    printJson({ generations });
    return;
  }
  if (!generations.length) {
    print('No generations yet.');
    return;
  }
  for (const item of generations) {
    print(
      `${item.id}  ${item.createdAt.slice(0, 16).replace('T', ' ')}  ${item.kind.padEnd(5)}  ${item.status.padEnd(7)}  ${item.model}  ${item.prompt.replace(/\s+/g, ' ').slice(0, 60)}`
    );
  }
}

export async function credits(api: Api, g: Globals): Promise<void> {
  const result = await api.credits();
  if (g.json) {
    printJson(result);
    return;
  }
  print(`${result.balance} credits (plan: ${result.plan ?? 'free'}).`);
  if (result.watermarked) {
    print(
      'No plan or credit pack yet: credits come from a plan or a credit pack (`makemidas credits buy`).'
    );
  } else {
    print(`Up to ${result.concurrency} at once, ${result.maxOutputs} outputs each.`);
  }
  for (const item of result.expiring.slice(0, 3)) {
    print(`  ${item.amount} expire ${item.expiresAt.slice(0, 10)}`);
  }
}

export async function models(
  api: Api,
  g: Globals,
  kind?: Kind
): Promise<void> {
  const result = await api.models(kind);
  if (g.json) {
    printJson({ models: result });
    return;
  }
  for (const model of result) {
    print(`${headline(model)}: ${prices(model)}`);
  }
}

function headline(model: Model): string {
  const task = 'task' in model ? ` ${model.task}` : '';
  return `${model.id}  ${model.kind}${task}${model.tier === 'free' ? ' (free)' : ''}  ${model.label}`;
}

function prices(model: Model): string {
  switch (model.kind) {
    case 'image':
      return model.credits.map((c) => `${c.resolution} ${c.credits}`).join(', ');
    case 'video':
      return `${model.credits.map((c) => `${c.resolution} ${c.creditsPerSecond}/s`).join(', ')}; ${model.durations.join('/')}s`;
    case 'audio':
      if (model.creditsPer1kChars !== undefined) {
        return `${model.creditsPer1kChars} per 1,000 characters`;
      }
      return `${model.creditsPerTrack ?? '?'} per request`;
    case 'transcription':
      return `${model.creditsPerHour} per hour of audio`;
    case 'edit':
      if (model.creditsPerSecond?.length) {
        return model.creditsPerSecond
          .map((c) => `${c.resolution} ${c.creditsPerSecond}/s`)
          .join(', ');
      }
      return (model.credits ?? [])
        .map((c) => `${c.resolution} ${c.credits}`)
        .join(', ');
  }
}

export async function modelDetails(
  api: Api,
  g: Globals,
  id: string
): Promise<void> {
  const result = await api.modelDetails(id);
  if (g.json) {
    printJson(result);
    return;
  }
  const { model, example } = result;
  print(headline(model));
  if (model.family) print(`  Family: ${model.family}`);
  if (model.aspectRatios?.length) {
    print(`  Aspect ratios: ${model.aspectRatios.join(', ')}`);
  }
  if (model.resolutions?.length) {
    const fallback = model.defaultResolution
      ? ` (default ${model.defaultResolution})`
      : '';
    print(`  Resolutions: ${model.resolutions.join(', ')}${fallback}`);
  }
  switch (model.kind) {
    case 'image': {
      const extra = model.creditsPerReference
        ? ` (+${model.creditsPerReference} credits each)`
        : '';
      print(`  References: up to ${model.maxReferences}${extra}`);
      print(`  Credits: ${prices(model)}`);
      break;
    }
    case 'video': {
      const fallback = model.defaultDuration
        ? ` (default ${model.defaultDuration}s)`
        : '';
      print(`  Durations: ${model.durations.join('/')}s${fallback}`);
      const modes = model.frameModes.map((mode) => {
        const limit = model.frameLimits?.[mode];
        if (!limit || mode === 'none') return mode;
        const images =
          limit.min === limit.max ? `${limit.min}` : `${limit.min}-${limit.max}`;
        return `${mode} (${images} image${limit.max === 1 ? '' : 's'})`;
      });
      print(`  Frame modes: ${modes.join(', ')}`);
      print(`  Audio: ${model.audio ? 'yes' : 'no'}`);
      const rates = model.credits.map(
        (c) =>
          `${c.resolution} ${c.creditsPerSecond}/s${c.creditsPerSecondWithAudio ? ` (${c.creditsPerSecondWithAudio}/s with audio)` : ''}`
      );
      const extra = model.creditsPerFrame
        ? `; +${model.creditsPerFrame} per frame or reference image`
        : '';
      print(`  Credits: ${rates.join(', ')}${extra}`);
      break;
    }
    case 'audio': {
      if (model.task !== 'speech') {
        const fallback = model.defaultDuration
          ? ` (default ${model.defaultDuration}s)`
          : '';
        print(
          `  Durations: ${model.durations.length ? `${model.durations.join('/')}s${fallback}` : 'set by the model'}`
        );
      }
      const options = [
        model.lyrics && 'lyrics',
        model.instrumental && 'instrumental',
        model.loop && 'loop and bpm',
        model.maxDeliveryChars && `delivery (up to ${model.maxDeliveryChars} characters)`,
        model.speedRange &&
          `speed ${model.speedRange.min}-${model.speedRange.max} and stability`,
      ].filter(Boolean);
      if (options.length) print(`  Options: ${options.join(', ')}`);
      if (model.maxChars) print(`  Text: up to ${model.maxChars} characters`);
      if (model.voices?.length) {
        print(`  Voices${model.defaultVoice ? ` (default ${model.defaultVoice})` : ''}:`);
        for (const voice of model.voices) {
          print(`    ${voice.id}  ${voice.name}: ${voice.description}`);
        }
      }
      if (model.languages?.length) {
        print(`  Languages: ${model.languages.join(', ')}`);
      }
      print(`  Credits: ${prices(model)}`);
      break;
    }
    case 'transcription':
      print(`  Languages: about ${model.languages}${model.speakers ? ', speaker labels' : ''}`);
      print(`  Files: ${model.formats}, up to ${Math.round(model.maxDurationSeconds / 60)} min and ${formatBytes(model.maxBytes)}`);
      print(`  Downloads: ${model.outputFormats.join(', ')}`);
      print(`  Credits: ${prices(model)}, at least 1`);
      break;
    case 'edit':
      print(`  Takes: ${model.input}`);
      print(`  Limits: ${model.limits}`);
      if (model.upscaleFactors?.length) {
        print(`  Scales: ${model.upscaleFactors.map((f) => `${f}x`).join(', ')}`);
      }
      print(`  Credits: ${prices(model)}`);
      break;
  }
  if (model.discount) {
    print(`  Discount: ${Math.round(model.discount * 100)}% off the list price`);
  }
  print('Example request:');
  print(JSON.stringify(example, null, 2));
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

export interface CompareRequest {
  prompt: string;
  models: string[];
  aspectRatio?: string;
  quotedCredits?: number;
}

/**
 * Price each model as the comparison will run it (one image at its default
 * size) and refuse when the total is over `maxCredits` or the balance.
 */
async function quotedComparison(
  api: Api,
  request: CompareRequest & { referenceIds: string[] },
  maxCredits: number
): Promise<number> {
  const quotes = await Promise.all(
    request.models.map((model) =>
      api.estimate({
        kind: 'image',
        prompt: request.prompt,
        model,
        count: 1,
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
        referenceIds: request.referenceIds,
      })
    )
  );
  const total = quotes.reduce((sum, quote) => sum + quote.credits, 0);
  const balance = quotes[0]?.balance ?? 0;
  if (total > maxCredits) {
    throw new CliError(
      `This comparison costs ${total} credits (${quotes.map((q) => `${q.model} ${q.credits}`).join(', ')}), over --max-credits ${maxCredits}. Nothing was charged.`,
      EXIT.CREDITS,
      'over_budget'
    );
  }
  if (total > balance) {
    throw new CliError(
      `This comparison costs ${total} credits and your balance is ${balance}. Nothing was charged.`,
      EXIT.CREDITS,
      'insufficient_credits'
    );
  }
  log(`Quoted ${total} credits.`);
  return total;
}

/** One prompt on 2-4 image models; saves every model's image. */
export async function compare(
  api: Api,
  g: Globals,
  request: CompareRequest,
  refs: string[],
  save: SaveOptions,
  maxCredits?: number
): Promise<void> {
  const referenceIds = await uploadRefs(api, refs);
  const body = { ...request, referenceIds };
  if (maxCredits !== undefined) {
    body.quotedCredits = await quotedComparison(api, body, maxCredits);
  }
  log(`Comparing ${request.models.join(', ')}…`);
  const result: Comparison = await api.compare(body);
  const files: string[] = [];
  for (const generation of result.generations) {
    files.push(...(await saveOutputs(api, generation, save)));
  }
  if (g.json) {
    printJson({ ...result, files });
  } else {
    for (const generation of result.generations) {
      const mine = files.filter((file) =>
        file.includes(`makemidas-${generation.id.slice(0, 8)}-`)
      );
      const links = mine.length
        ? mine
        : generation.outputs.flatMap((o) => (o.url ? [o.url] : []));
      for (const line of links) print(`${generation.model}  ${line}`);
      log(
        `${generation.model} ${generation.id}: ${generation.status}, ${generation.credits} credits${generation.error ? ` (${generation.error})` : ''}.`
      );
    }
    log(`${result.credits} credits in all.`);
  }
  for (const item of result.failed) {
    warn(`${item.model} did not start: ${item.error.message}`);
  }
  if (!result.generations.some((generation) => generation.status === 'done')) {
    const first = result.failed[0]?.error;
    throw new CliError(
      first?.message ??
        result.generations[0]?.error ??
        'No model could make this; credits were refunded.',
      EXIT.FAILED,
      'generation_failed',
      first
        ? {
            ...(first.retryable !== undefined ? { retryable: first.retryable } : {}),
            ...(first.requiresPromptRevision !== undefined
              ? { requiresPromptRevision: first.requiresPromptRevision }
              : {}),
          }
        : {}
    );
  }
}

// ---------------------------------------------------------------------------
// delete / feedback / credits link
// ---------------------------------------------------------------------------

/** Ask a yes/no question on the terminal; anything but y/yes is no. */
export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export interface DeleteOptions {
  /** --yes: skip the question. */
  yes: boolean;
  /** Whether a person can answer (stdin is a terminal). */
  interactive: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

export async function deleteGeneration(
  api: Api,
  g: Globals,
  id: string | undefined,
  opts: DeleteOptions
): Promise<void> {
  if (!id) {
    throw new CliError(
      'Give a generation id: `makemidas delete <id>`.',
      EXIT.USAGE,
      'usage'
    );
  }
  if (!opts.yes) {
    if (!opts.interactive) {
      throw new CliError(
        `Deleting ${id} removes its files for good. Run again with --yes to confirm.`,
        EXIT.USAGE,
        'confirmation_required'
      );
    }
    const confirm = opts.confirm ?? askYesNo;
    const ok = await confirm(
      `Delete generation ${id} and its files for good? Credits are not refunded.`
    );
    if (!ok) {
      throw new CliError('Not deleted.', EXIT.USAGE, 'cancelled');
    }
  }
  const result = await api.deleteGeneration(id);
  if (g.json) printJson(result);
  else print(`Deleted ${result.id}.`);
}

export async function feedback(
  api: Api,
  g: Globals,
  input: FeedbackInput
): Promise<void> {
  if (!input.message.trim()) {
    throw new CliError(
      'Give a message: `makemidas feedback "The upscale kept the noise"`.',
      EXIT.USAGE,
      'usage'
    );
  }
  const result = await api.feedback({ ...input, message: input.message.trim() });
  if (g.json) printJson(result);
  else print('Thanks, your feedback was sent.');
}

/** Where to buy credits; prints links only and opens nothing. */
export async function creditsLink(api: Api, g: Globals): Promise<void> {
  const result = await api.purchaseLink();
  if (g.json) {
    printJson(result);
    return;
  }
  print(result.url);
  print(`Balance: ${result.balance} credits (plan: ${result.plan ?? 'none'}).`);
  if (!result.purchasable) {
    print('Checkout is switched off on this site for now.');
  }
  if (result.plans.length) {
    print(`Plans (${result.plansUrl}):`);
    for (const plan of result.plans) {
      const marks = [plan.current && 'current', plan.popular && 'popular']
        .filter(Boolean)
        .join(', ');
      print(
        `  ${plan.name}: $${plan.priceUsd}/${plan.interval}, ${plan.monthlyCredits} credits a month, ${plan.concurrency} at once${marks ? ` (${marks})` : ''}`
      );
    }
  }
  if (result.packs.length) {
    print(`Credit packs (${result.packsUrl}):`);
    for (const pack of result.packs) {
      print(
        `  $${pack.priceUsd}: ${pack.credits} credits (${pack.subscriberCredits} with a plan)${pack.popular ? ' (popular)' : ''}`
      );
    }
  }
  print(`Manage billing: ${result.billingUrl}`);
}

// ---------------------------------------------------------------------------
// brands, characters, assets (read-only: what a creative brief can use)
// ---------------------------------------------------------------------------

export async function brands(api: Api, g: Globals, id?: string): Promise<void> {
  if (id) {
    const brand = await api.brand(id);
    if (g.json) return printJson(brand);
    print(`${brand.name} (${brand.id})${brand.isDefault ? ' · default' : ''}`);
    print(brand.guidelines);
    return;
  }
  const list = await api.brands();
  if (g.json) return printJson({ brands: list });
  if (!list.length) return print('No saved brands (add one on makemidas.com/dashboard/brands).');
  for (const brand of list) {
    const palette = brand.colors.map((c) => c.hex).join(' ');
    print(`${brand.id}  ${brand.isDefault ? '*' : ' '} ${brand.name}${palette ? `  ${palette}` : ''}`);
  }
}

export async function characters(api: Api, g: Globals): Promise<void> {
  const list = await api.characters();
  if (g.json) return printJson({ characters: list });
  if (!list.length) return print('No saved characters (add one on makemidas.com/dashboard/characters).');
  for (const c of list) {
    print(`${c.id}  ${c.name} (${c.imageCount} image${c.imageCount === 1 ? '' : 's'})${c.description ? `: ${c.description}` : ''}`);
  }
}

export async function assets(
  api: Api,
  g: Globals,
  query: { q?: string; kind?: string; limit?: number }
): Promise<void> {
  const page = await api.assets(query);
  if (g.json) return printJson(page);
  if (!page.assets.length) return print('No matching files in the asset library.');
  for (const a of page.assets) {
    const size = a.width && a.height ? `${a.width}x${a.height}` : a.durationSeconds ? `${a.durationSeconds}s` : '';
    print(`${a.id}  ${a.kind.padEnd(5)}  ${a.name}${size ? `  ${size}` : ''}${a.tags.length ? `  #${a.tags.join(' #')}` : ''}`);
  }
}
