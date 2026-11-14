import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Api, Estimate, Generation, GenerationInput, Model } from './api.ts';
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
};

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
    const ext = EXTENSIONS[type.split(';')[0]] ?? 'bin';
    const file = join(dir, `makemidas-${generation.id.slice(0, 8)}-${index + 1}.${ext}`);
    if (existsSync(file) && !save.force) {
      warn(`${file} exists; skipped (use --force to overwrite).`);
      continue;
    }
    await writeFile(file, bytes);
    log(`Saved ${file} (${formatBytes(bytes.byteLength)})`);
    files.push(file);
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
  files: string[]
): void {
  if (g.json) {
    printJson({ ...generation, files });
  } else {
    if (files.length) for (const file of files) print(file);
    else {
      for (const output of generation.outputs) if (output.url) print(output.url);
    }
    log(
      `${generation.kind} ${generation.id}: ${generation.status}, ${generation.credits} credits${generation.watermarked ? ' (watermarked: free plan)' : ''}.`
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

export async function generate(
  api: Api,
  g: Globals,
  input: GenerationInput,
  refs: string[],
  save: SaveOptions,
  wait: WaitOptions
): Promise<void> {
  const referenceIds = await uploadRefs(api, refs);
  log(`Generating ${input.kind}…`);
  let generation = await api.generate({ ...input, referenceIds });
  if (generation.status === 'running' && wait.wait) {
    generation = await waitFor(api, generation, wait.timeoutMin);
  }
  const files = await saveOutputs(api, generation, save);
  report(g, generation, files);
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
  const parts = [request.aspectRatio];
  if (request.resolution) parts.push(request.resolution);
  if (request.duration) parts.push(`${request.duration}s`);
  if (request.audio) parts.push('audio');
  if (request.frameMode && request.frameMode !== 'none') {
    parts.push(`frame mode ${request.frameMode}`);
  }
  parts.push(`${request.count} output${request.count === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export async function estimate(
  api: Api,
  g: Globals,
  input: GenerationInput,
  refs: string[]
): Promise<void> {
  const referenceIds = await uploadRefs(api, refs);
  const result = await api.estimate({ ...input, referenceIds });
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
    `Nothing was charged. Generate at this price with \`makemidas ${input.kind}\` and the same options plus --quoted-credits ${result.credits}.`
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
    print('Free plan: 10 credits a day, free models only, watermarked images.');
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
  kind?: 'image' | 'video'
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
  return `${model.id}  ${model.kind}${model.tier === 'free' ? ' (free)' : ''}  ${model.label}`;
}

function prices(model: Model): string {
  return model.kind === 'image'
    ? model.credits.map((c) => `${c.resolution} ${c.credits}`).join(', ')
    : `${model.credits.map((c) => `${c.resolution} ${c.creditsPerSecond}/s`).join(', ')}; ${model.durations.join('/')}s`;
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
  print(`  Aspect ratios: ${model.aspectRatios.join(', ')}`);
  if (model.resolutions?.length) {
    const fallback = model.defaultResolution
      ? ` (default ${model.defaultResolution})`
      : '';
    print(`  Resolutions: ${model.resolutions.join(', ')}${fallback}`);
  }
  if (model.kind === 'image') {
    const extra = model.creditsPerReference
      ? ` (+${model.creditsPerReference} credits each)`
      : '';
    print(`  References: up to ${model.maxReferences}${extra}`);
    print(`  Credits: ${prices(model)}`);
  } else {
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
  }
  if (model.discount) {
    print(`  Discount: ${Math.round(model.discount * 100)}% off the list price`);
  }
  print('Example request:');
  print(JSON.stringify(example, null, 2));
}
