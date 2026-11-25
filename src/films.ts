import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Api,
  Film,
  FilmPart,
  FilmSettings,
  FilmShotInput,
  FilmUpdate,
} from './api.ts';
import {
  askYesNo,
  type Globals,
  type SaveOptions,
  writeOutput,
} from './commands.ts';
import { CliError, EXIT } from './errors.ts';
import { log, print, printJson } from './output.ts';

/*
 * `makemidas film …`: film projects. A brief becomes a script and a
 * storyboard; the frames and then the film are approved at the credits
 * shown; the service assembles the film, or the pieces and a timeline come
 * down for an agent to assemble itself.
 */

/** Steps the service is working on; waiting polls through them. */
const WORKING = new Set<Film['next']>(['making_frames', 'making_film', 'assembling']);

/** Seconds between polls: a render moves on each poll, so poll it often. */
const POLL_SECONDS = { assembling: 8, other: 15 } as const;

export interface PriceOptions {
  /** Refuse when the step costs more than this. */
  maxCredits?: number;
  /** Charge exactly this, or nothing. */
  quotedCredits?: number;
}

export interface FilmWait {
  wait: boolean;
  timeoutMin: number;
  /** Overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const short = (id: string) => id.slice(0, 8);

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`Give ${what}.`, EXIT.USAGE, 'usage');
  return value;
}

/** The credits to send for a step priced at `credits`, or a refusal. */
export function priceFor(
  credits: number,
  what: string,
  price: PriceOptions,
  retry: string
): number {
  if (price.quotedCredits !== undefined) return price.quotedCredits;
  if (price.maxCredits === undefined) {
    throw new CliError(
      `${what} costs ${credits} credits. Run again with --quoted-credits ${credits} (or --max-credits <n>): ${retry} --quoted-credits ${credits}`,
      EXIT.USAGE,
      'quote_required'
    );
  }
  if (credits > price.maxCredits) {
    throw new CliError(
      `${what} costs ${credits} credits, over --max-credits ${price.maxCredits}. Nothing was charged.`,
      EXIT.CREDITS,
      'over_budget'
    );
  }
  return credits;
}

function pieceMark(label: string, piece: Film['shots'][number]['frame']): string {
  if (!piece) return `${label} -`;
  const marks = { queued: '…', running: '…', done: '✓', failed: '✗' } as const;
  return `${label} ${marks[piece.status]}`;
}

/** What to run next, as one line a person or an agent can follow. */
export function nextHint(film: Film): string {
  const id = film.id;
  switch (film.next) {
    case 'write_storyboard':
      return `Write the storyboard: makemidas film write ${id} --max-credits 40`;
    case 'approve_frames':
      return `Approve the first frames for ${film.pendingCredits} credits: makemidas film approve ${id} frames --quoted-credits ${film.pendingCredits}`;
    case 'making_frames':
      return `Drawing the first frames (they start within a minute): makemidas film get ${id} --wait`;
    case 'approve_film':
      return `Check the frames, then approve the film for ${film.pendingCredits} credits: makemidas film approve ${id} film --quoted-credits ${film.pendingCredits}`;
    case 'making_film':
      return `Making the clips, voiceover and music: makemidas film get ${id} --wait`;
    case 'assemble':
      return `Every piece is ready: makemidas film assemble ${id} (or makemidas film download ${id} --pieces to cut it yourself)`;
    case 'assembling':
      return `Assembling: makemidas film get ${id} --wait`;
    case 'done':
      return `Finished: makemidas film download ${id}`;
    case 'paused':
      return `Paused (${film.pausedReason ?? 'stopped'}): top up credits, then makemidas film resume ${id}`;
  }
}

/** A project as a few lines of text. */
export function describeFilm(film: Film): string[] {
  const lines = [
    `${film.title} (${film.id}) · ${film.stage} · ${film.shots.length} shot${film.shots.length === 1 ? '' : 's'} · ${film.seconds} s`,
  ];
  for (const shot of film.shots) {
    const parts = [
      pieceMark('frame', shot.frame),
      pieceMark('clip', shot.clip),
      ...(shot.voiceover ? [pieceMark('voice', shot.voice)] : []),
    ].join('  ');
    lines.push(
      `  ${shot.position + 1}. ${shot.duration}s  [${parts}]  ${shot.description || shot.prompt.slice(0, 80)}`
    );
    if (shot.error) lines.push(`     error: ${shot.error}`);
  }
  if (film.assembly?.status === 'failed') {
    lines.push(`  assembly failed: ${film.assembly.error ?? 'unknown error'}`);
  }
  if (film.filmUrl) lines.push(`  film: ${film.filmUrl}`);
  lines.push(`Next: ${nextHint(film)}`);
  lines.push(`Web: ${film.webUrl}`);
  return lines;
}

function show(g: Globals, film: Film, files: string[] = []): void {
  if (g.json) printJson({ ...film, files });
  else for (const line of describeFilm(film)) print(line);
  for (const file of files) if (!g.json) print(file);
}

/** Poll until the service stops working on the project, or time runs out. */
export async function waitForFilm(
  api: Api,
  film: Film,
  wait: FilmWait
): Promise<Film> {
  const pause = wait.sleep ?? sleep;
  const deadline = Date.now() + wait.timeoutMin * 60_000;
  let current = film;
  while (WORKING.has(current.next) && Date.now() < deadline) {
    log(`${current.next.replace('_', ' ')}… (${short(current.id)})`);
    const seconds =
      current.next === 'assembling' ? POLL_SECONDS.assembling : POLL_SECONDS.other;
    await pause(seconds * 1000);
    current = await api.film(current.id);
  }
  return current;
}

/** The exit a waited-on project ends with. */
function settle(film: Film, waited: boolean): void {
  if (film.next === 'paused') {
    throw new CliError(
      `Paused: ${film.pausedReason ?? 'stopped'}. Top up, then \`makemidas film resume ${film.id}\`.`,
      EXIT.CREDITS,
      film.pausedReason ?? 'paused'
    );
  }
  if (film.assembly?.status === 'failed' && film.next !== 'done') {
    throw new CliError(
      `Assembly failed: ${film.assembly.error ?? 'unknown error'}. Run \`makemidas film assemble ${film.id}\` again, or \`makemidas film download ${film.id} --pieces\` to cut it yourself.`,
      EXIT.FAILED,
      'generation_failed'
    );
  }
  if (waited && WORKING.has(film.next)) {
    throw new CliError(
      `Still working (${film.next}). Run \`makemidas film get ${film.id} --wait\` later.`,
      EXIT.NOT_READY,
      'not_ready'
    );
  }
}

/** Save the assembled film as `<dir>/film-<id>.mp4`. */
async function saveFilm(api: Api, film: Film, save: SaveOptions): Promise<string[]> {
  if (!save.out || !film.filmUrl) return [];
  const dir = resolve(save.out);
  await mkdir(dir, { recursive: true });
  const { bytes } = await api.download(film.filmUrl);
  const file = join(dir, `film-${short(film.id)}.mp4`);
  return (await writeOutput(file, bytes, save.force)) ? [file] : [];
}

const EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Every piece of a finished storyboard into `<dir>/film-<id>/`: the clips,
 * voiceovers and music, and `timeline.json` saying where each goes, with
 * its paths swapped for the local files.
 */
async function savePieces(api: Api, film: Film, save: SaveOptions): Promise<string[]> {
  if (!film.timeline) {
    throw new CliError(
      `The clips are not all made yet (${film.next}). Run \`makemidas film get ${film.id} --wait\` first.`,
      EXIT.NOT_READY,
      'not_ready'
    );
  }
  const dir = resolve(save.out ?? '.', `film-${short(film.id)}`);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const fetchTo = async (url: string, name: string): Promise<string> => {
    const { bytes, type } = await api.download(url);
    const file = join(dir, `${name}.${EXT[type.split(';')[0].trim()] ?? 'bin'}`);
    if (await writeOutput(file, bytes, save.force)) files.push(file);
    return file;
  };
  const timeline = film.timeline;
  const clips = [];
  for (const [i, clip] of timeline.clips.entries()) {
    clips.push({ ...clip, file: await fetchTo(clip.url, `clip-${i + 1}`) });
  }
  const voiceover = [];
  for (const line of timeline.voiceover) {
    const n = film.shots.findIndex((shot) => shot.id === line.shotId) + 1;
    voiceover.push({ ...line, file: await fetchTo(line.url, `voice-${n}`) });
  }
  const music = timeline.music
    ? { ...timeline.music, file: await fetchTo(timeline.music.url, 'music') }
    : null;
  const local = { ...timeline, clips, voiceover, music };
  const json = join(dir, 'timeline.json');
  if (
    await writeOutput(
      json,
      new TextEncoder().encode(`${JSON.stringify(local, null, 2)}\n`),
      save.force
    )
  ) {
    files.push(json);
  }
  return files;
}

// ---------------------------------------------------------------- commands

export async function filmList(api: Api, g: Globals): Promise<void> {
  const films = await api.films();
  if (g.json) return printJson({ films });
  if (!films.length) {
    print('No film projects yet. Start one: makemidas film new "<brief>"');
    return;
  }
  for (const film of films) {
    print(
      `${film.id}  ${film.stage.padEnd(10)}  ${String(film.shots).padStart(2)} shots  ${String(film.seconds).padStart(3)} s  ${film.title}`
    );
  }
}

export interface NewFilm {
  brief: string;
  title?: string;
  settings: Partial<FilmSettings>;
  /** Write the storyboard right away (charged by the tokens used). */
  write: boolean;
  targetSeconds?: number;
}

/** Make the storyboard, priced first; `price` caps the most it can cost. */
async function write(
  api: Api,
  id: string,
  input: { targetSeconds?: number; brief?: string },
  price: PriceOptions
): Promise<Film> {
  const quote = await api.storyboardQuote(id, input.targetSeconds);
  const quoted = priceFor(
    quote.credits,
    `Writing the storyboard (${quote.model}, at most)`,
    price,
    `makemidas film write ${id}`
  );
  log(`Writing the script and storyboard (up to ${quoted} credits, charged by what it writes)…`);
  return api.writeStoryboard(id, { ...input, quotedCredits: quoted });
}

export async function filmNew(
  api: Api,
  g: Globals,
  input: NewFilm,
  price: PriceOptions
): Promise<void> {
  if (!input.brief.trim()) {
    throw new CliError(
      'Describe the film: `makemidas film new "a 10-second ad for …"`.',
      EXIT.USAGE,
      'usage'
    );
  }
  let film = await api.createFilm({
    brief: input.brief,
    ...(input.title ? { title: input.title } : {}),
    ...(Object.keys(input.settings).length ? { settings: input.settings } : {}),
  });
  log(`Created film ${film.id}.`);
  if (input.write) {
    film = await write(api, film.id, { targetSeconds: input.targetSeconds }, price);
  }
  show(g, film);
}

export async function filmGet(
  api: Api,
  g: Globals,
  id: string | undefined,
  save: SaveOptions,
  wait: FilmWait
): Promise<void> {
  let film = await api.film(need(id, 'a film id: `makemidas film get <id>`'));
  if (wait.wait) film = await waitForFilm(api, film, wait);
  const files = film.next === 'done' ? await saveFilm(api, film, save) : [];
  show(g, film, files);
  settle(film, wait.wait);
}

export async function filmWrite(
  api: Api,
  g: Globals,
  id: string | undefined,
  input: { targetSeconds?: number; brief?: string },
  price: PriceOptions
): Promise<void> {
  const film = await write(
    api,
    need(id, 'a film id: `makemidas film write <id>`'),
    input,
    price
  );
  show(g, film);
}

export async function filmApprove(
  api: Api,
  g: Globals,
  id: string | undefined,
  stage: string | undefined,
  price: PriceOptions,
  save: SaveOptions,
  wait: FilmWait
): Promise<void> {
  const filmId = need(id, 'a film id: `makemidas film approve <id> frames|film`');
  if (stage !== 'frames' && stage !== 'film') {
    throw new CliError(
      'Approve `frames` (the first frames) or `film` (clips, voiceover, music and the film).',
      EXIT.USAGE,
      'usage'
    );
  }
  let film = await api.film(filmId);
  if (film.next !== `approve_${stage}`) {
    throw new CliError(
      `Nothing to approve for ${stage} now. ${nextHint(film)}`,
      EXIT.USAGE,
      'wrong_stage'
    );
  }
  const quoted = priceFor(
    film.pendingCredits,
    stage === 'frames' ? 'Drawing the first frames' : 'Making the film',
    price,
    `makemidas film approve ${filmId} ${stage}`
  );
  film = await api.approveFilm(filmId, { stage, quotedCredits: quoted });
  log(`Approved ${stage} for ${quoted} credits.`);
  if (wait.wait) film = await waitForFilm(api, film, wait);
  const files = film.next === 'done' ? await saveFilm(api, film, save) : [];
  show(g, film, files);
  settle(film, wait.wait);
}

/** A shot by its number in the storyboard (1-based) or its id. */
export function findShot(film: Film, ref: string): Film['shots'][number] {
  const n = Number(ref);
  const shot = Number.isInteger(n)
    ? film.shots.find((s) => s.position === n - 1)
    : film.shots.find((s) => s.id === ref);
  if (!shot) {
    throw new CliError(
      `No shot ${ref}; give its number (1-${film.shots.length}) or id.`,
      EXIT.USAGE,
      'not_found'
    );
  }
  return shot;
}

export async function filmRedo(
  api: Api,
  g: Globals,
  id: string | undefined,
  shotRef: string | undefined,
  part: string | undefined,
  price: PriceOptions,
  wait: FilmWait
): Promise<void> {
  const filmId = need(id, 'a film id: `makemidas film redo <id> <shot> frame|clip|voice`');
  if (part !== 'frame' && part !== 'clip' && part !== 'voice') {
    throw new CliError('Redo a `frame`, `clip` or `voice`.', EXIT.USAGE, 'usage');
  }
  let film = await api.film(filmId);
  const shot = findShot(film, need(shotRef, 'a shot number or id'));
  // A new first frame after approval makes its clip again too.
  const approved = film.stage === 'film' || film.stage === 'assembled';
  const credits =
    shot.credits[part as FilmPart] + (part === 'frame' && approved ? shot.credits.clip : 0);
  const quoted = priceFor(
    credits,
    `Redoing shot ${shot.position + 1}'s ${part}`,
    price,
    `makemidas film redo ${filmId} ${shot.position + 1} ${part}`
  );
  film = await api.redoShot(filmId, shot.id, { part: part as FilmPart, quotedCredits: quoted });
  log(`Redoing shot ${shot.position + 1}'s ${part} for ${quoted} credits.`);
  if (wait.wait) film = await waitForFilm(api, film, wait);
  show(g, film);
  settle(film, wait.wait);
}

export async function filmResume(
  api: Api,
  g: Globals,
  id: string | undefined,
  wait: FilmWait
): Promise<void> {
  let film = await api.resumeFilm(need(id, 'a film id: `makemidas film resume <id>`'));
  if (wait.wait) film = await waitForFilm(api, film, wait);
  show(g, film);
  settle(film, wait.wait);
}

export async function filmAssemble(
  api: Api,
  g: Globals,
  id: string | undefined,
  save: SaveOptions,
  wait: FilmWait
): Promise<void> {
  let film = await api.assembleFilm(
    need(id, 'a film id: `makemidas film assemble <id>`')
  );
  if (wait.wait) film = await waitForFilm(api, film, wait);
  const files = film.next === 'done' ? await saveFilm(api, film, save) : [];
  show(g, film, files);
  settle(film, wait.wait);
}

export async function filmDownload(
  api: Api,
  g: Globals,
  id: string | undefined,
  save: SaveOptions,
  opts: { pieces: boolean }
): Promise<void> {
  const film = await api.film(need(id, 'a film id: `makemidas film download <id>`'));
  const out: SaveOptions = { ...save, out: save.out ?? '.' };
  let files: string[];
  if (opts.pieces) {
    files = await savePieces(api, film, out);
  } else {
    if (!film.filmUrl) {
      throw new CliError(
        `The film is not assembled yet (${film.next}). ${nextHint(film)}`,
        EXIT.NOT_READY,
        'not_ready'
      );
    }
    files = await saveFilm(api, film, out);
  }
  if (g.json) printJson({ id: film.id, files });
  else for (const file of files) print(file);
}

/** The storyboard file `film update --file` reads: shots, or `{ shots }`. */
export async function readStoryboard(path: string): Promise<FilmShotInput[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`Can't read ${path}`, EXIT.USAGE, 'invalid_file');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON.`, EXIT.USAGE, 'invalid_file');
  }
  const shots = Array.isArray(json)
    ? json
    : (json as { shots?: unknown }).shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new CliError(
      `${path} must hold a list of shots (or { "shots": [...] }), each with prompt and duration.`,
      EXIT.USAGE,
      'invalid_file'
    );
  }
  return shots as FilmShotInput[];
}

export async function filmUpdate(
  api: Api,
  g: Globals,
  id: string | undefined,
  input: FilmUpdate
): Promise<void> {
  const filmId = need(id, 'a film id: `makemidas film update <id> …`');
  if (!Object.keys(input).length) {
    throw new CliError(
      'Say what to change: --title, --brief, --file storyboard.json, or a setting such as --voice.',
      EXIT.USAGE,
      'usage'
    );
  }
  show(g, await api.updateFilm(filmId, input));
}

export async function filmDelete(
  api: Api,
  g: Globals,
  id: string | undefined,
  opts: { yes: boolean; interactive: boolean; confirm?: (q: string) => Promise<boolean> }
): Promise<void> {
  const filmId = need(id, 'a film id: `makemidas film delete <id>`');
  if (!opts.yes) {
    if (!opts.interactive) {
      throw new CliError(
        `Deleting film ${filmId} removes the project and its assembled film (its generations stay). Run again with --yes to confirm.`,
        EXIT.USAGE,
        'confirmation_required'
      );
    }
    const ok = await (opts.confirm ?? askYesNo)(
      `Delete film project ${filmId}? Its frames and clips stay in your creations.`
    );
    if (!ok) throw new CliError('Not deleted.', EXIT.USAGE, 'cancelled');
  }
  await api.deleteFilm(filmId);
  if (g.json) printJson({ id: filmId, deleted: true });
  else print(`Deleted film ${filmId}.`);
}
