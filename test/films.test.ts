import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api, type Film } from '../src/api.ts';
import { filmSettings, parse } from '../src/args.ts';
import { CliError, EXIT } from '../src/errors.ts';
import * as films from '../src/films.ts';
import { setQuiet } from '../src/output.ts';

process.env.MAKEMIDAS_API_KEY = 'mm_test';
setQuiet(true);

const ID = '11111111-2222-3333-4444-555555555555';
const SHOT = (n: number, extra: Partial<Film['shots'][number]> = {}) => ({
  id: `00000000-0000-0000-0000-00000000000${n}`,
  position: n - 1,
  description: `Shot ${n}`,
  prompt: `A lighthouse, shot ${n}`,
  camera: null,
  duration: 4,
  characterId: null,
  voiceover: n === 2 ? 'Every day begins with a little light.' : null,
  assetIds: [],
  error: null,
  frame: null,
  clip: null,
  voice: null,
  credits: { frame: 5, clip: 32, voice: 1 },
  ...extra,
});

function film(extra: Partial<Film> = {}): Film {
  return {
    id: ID,
    title: 'First Light',
    brief: 'A lighthouse keeper at dawn',
    stage: 'storyboard',
    settings: {
      aspectRatio: '16:9',
      videoModel: 'bytedance/seedance-2.0-mini',
      resolution: '480p',
      frameModel: 'black-forest-labs/flux-3-image-klein',
      clipAudio: false,
      speechModel: 'google/gemini-3.8-flash-lite-tts',
      voice: null,
      musicModel: null,
      musicPrompt: null,
      textModel: 'anthropic/claude-sonnet-5.5',
      brandId: null,
      characterIds: [],
      transition: 'crossfade',
    },
    script: 'Before dawn…',
    pausedReason: null,
    shots: [SHOT(1), SHOT(2)],
    music: null,
    assembly: null,
    pendingCredits: 10,
    next: 'approve_frames',
    seconds: 8,
    filmUrl: null,
    timeline: null,
    webUrl: `https://makemidas.test/dashboard/films/${ID}`,
    ...extra,
  };
}

const done = { generationId: 'g', status: 'done' as const };

/** An Api whose fetch answers from `routes` ("METHOD path" → body). */
function fake(routes: Record<string, (body: unknown) => unknown>) {
  const api = new Api('https://makemidas.test');
  const calls: { key: string; body: unknown }[] = [];
  api.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'files.test') {
      const type = url.pathname.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': type } });
    }
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    if (!handler) return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 });
    return Response.json(handler(body));
  }) as typeof fetch;
  return { api, calls };
}

const g = { json: true };
const quiet = async (fn: () => Promise<void>) => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
};
const noWait = { wait: false, timeoutMin: 1 };
const noSave = { out: null, force: false };

test('a paid step needs a price: shown, capped or quoted', () => {
  assert.throws(
    () => films.priceFor(10, 'Frames', {}, 'makemidas film approve x frames'),
    (e: CliError) => e.code === 'quote_required' && /--quoted-credits 10/.test(e.message)
  );
  assert.throws(
    () => films.priceFor(10, 'Frames', { maxCredits: 5 }, ''),
    (e: CliError) => e.exitCode === EXIT.CREDITS && e.code === 'over_budget'
  );
  assert.equal(films.priceFor(10, 'Frames', { maxCredits: 40 }, ''), 10);
  assert.equal(films.priceFor(10, 'Frames', { quotedCredits: 12 }, ''), 12);
});

test('film new creates the project, then writes it at the quoted price', async () => {
  const { api, calls } = fake({
    'POST /films': () => film({ stage: 'draft', next: 'write_storyboard', shots: [] }),
    [`GET /films/${ID}/storyboard`]: () => ({ credits: 31, model: 'anthropic/claude-sonnet-5.5' }),
    [`POST /films/${ID}/storyboard`]: () => film(),
  });
  await quiet(() =>
    films.filmNew(
      api,
      g,
      {
        brief: 'A lighthouse keeper at dawn',
        settings: { aspectRatio: '16:9', musicModel: null },
        write: true,
        targetSeconds: 10,
      },
      { maxCredits: 40 }
    )
  );
  assert.deepEqual(
    calls.map((c) => c.key),
    ['POST /films', `GET /films/${ID}/storyboard`, `POST /films/${ID}/storyboard`]
  );
  assert.deepEqual(calls[0].body, {
    brief: 'A lighthouse keeper at dawn',
    settings: { aspectRatio: '16:9', musicModel: null },
  });
  assert.deepEqual(calls[2].body, { targetSeconds: 10, quotedCredits: 31 });
});

test('approve refuses the wrong stage and sends the price shown', async () => {
  const { api, calls } = fake({
    [`GET /films/${ID}`]: () => film(),
    [`POST /films/${ID}/approve`]: () => film({ stage: 'frames', next: 'making_frames', pendingCredits: 0 }),
  });
  await assert.rejects(
    films.filmApprove(api, g, ID, 'film', { maxCredits: 100 }, noSave, noWait),
    (e: CliError) => e.code === 'wrong_stage'
  );
  await quiet(() =>
    films.filmApprove(api, g, ID, 'frames', { maxCredits: 20 }, noSave, noWait)
  );
  assert.deepEqual(calls.at(-1)?.body, { stage: 'frames', quotedCredits: 10 });
});

test('waiting polls until the film is assembled, then saves it', async () => {
  // GET answers in turn: the approval check, then two polls.
  const reads: Partial<Film>[] = [
    { stage: 'frames', next: 'approve_film', pendingCredits: 66 },
    { stage: 'film', next: 'assembling', pendingCredits: 0, assembly: { generationId: '', status: 'running' } },
    {
      stage: 'assembled',
      next: 'done',
      pendingCredits: 0,
      assembly: { generationId: '', status: 'done' },
      filmUrl: 'https://files.test/film.mp4',
    },
  ];
  const { api, calls } = fake({
    [`GET /films/${ID}`]: () => film(reads.shift()),
    [`POST /films/${ID}/approve`]: () => film({ stage: 'film', next: 'making_film', pendingCredits: 0 }),
  });
  const naps: number[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'mm-film-'));
  await quiet(() =>
    films.filmApprove(
      api,
      g,
      ID,
      'film',
      { quotedCredits: 66 },
      { out: dir, force: false },
      { wait: true, timeoutMin: 1, sleep: async (ms) => void naps.push(ms) }
    )
  );
  assert.deepEqual(calls.find((c) => c.key.startsWith('POST'))?.body, {
    stage: 'film',
    quotedCredits: 66,
  });
  // The clips are polled every 15 s, the assembly every 8 s (polls drive it).
  assert.deepEqual(naps, [15_000, 8_000]);
  const saved = await readFile(join(dir, `film-${ID.slice(0, 8)}.mp4`));
  assert.equal(saved.byteLength, 3);
});

test('a paused film ends with the credits exit code', async () => {
  const { api } = fake({
    [`GET /films/${ID}`]: () => film({ stage: 'film', next: 'paused', pausedReason: 'insufficient_credits' }),
  });
  await assert.rejects(
    quiet(() => films.filmGet(api, g, ID, noSave, noWait)),
    (e: CliError) => e.exitCode === EXIT.CREDITS
  );
});

test('redo finds a shot by number and adds the clip to a new frame after approval', async () => {
  const { api, calls } = fake({
    [`GET /films/${ID}`]: () => film({ stage: 'film', next: 'assemble', pendingCredits: 0 }),
    [`POST /films/${ID}/shots/${SHOT(2).id}/redo`]: () => film({ stage: 'film', next: 'making_film' }),
  });
  await quiet(() => films.filmRedo(api, g, ID, '2', 'frame', { maxCredits: 50 }, noWait));
  assert.deepEqual(calls.at(-1)?.body, { part: 'frame', quotedCredits: 37 });
  assert.throws(() => films.findShot(film(), '9'), (e: CliError) => e.code === 'not_found');
});

test('download --pieces saves every piece and a local timeline', async () => {
  const shots = [
    SHOT(1, { clip: { ...done, url: 'https://files.test/c1.mp4' } }),
    SHOT(2, {
      clip: { ...done, url: 'https://files.test/c2.mp4' },
      voice: { ...done, url: 'https://files.test/v2.mp3' },
    }),
  ];
  const { api } = fake({
    [`GET /films/${ID}`]: () =>
      film({
        stage: 'film',
        next: 'assemble',
        shots,
        timeline: {
          aspectRatio: '16:9',
          resolution: '480p',
          transition: 'crossfade',
          seconds: 8,
          clips: [
            { shotId: shots[0].id, start: 0, duration: 4, url: 'https://files.test/c1.mp4' },
            { shotId: shots[1].id, start: 4, duration: 4, url: 'https://files.test/c2.mp4' },
          ],
          voiceover: [{ shotId: shots[1].id, start: 4, url: 'https://files.test/v2.mp3' }],
          music: null,
          howTo: 'concat',
        },
      }),
  });
  const dir = await mkdtemp(join(tmpdir(), 'mm-pieces-'));
  await quiet(() => films.filmDownload(api, g, ID, { out: dir, force: false }, { pieces: true }));
  const base = join(dir, `film-${ID.slice(0, 8)}`);
  const timeline = JSON.parse(await readFile(join(base, 'timeline.json'), 'utf8'));
  assert.equal(timeline.clips[1].file, join(base, 'clip-2.mp4'));
  assert.equal(timeline.voiceover[0].file, join(base, 'voice-2.mp3'));
  assert.equal(timeline.voiceover[0].start, 4);
});

test('a storyboard file is a list of shots or { shots }', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-board-'));
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  await writeFile(a, JSON.stringify([{ prompt: 'x', duration: 4 }]));
  await writeFile(b, JSON.stringify({ shots: [{ prompt: 'y', duration: 5 }] }));
  assert.equal((await films.readStoryboard(a))[0].prompt, 'x');
  assert.equal((await films.readStoryboard(b))[0].duration, 5);
  await assert.rejects(films.readStoryboard(join(dir, 'missing.json')));
});

test('film settings come from flags; none and default clear a choice', () => {
  const { values } = parse([
    'film',
    'new',
    'x',
    '--music-model',
    'none',
    '--voice',
    'default',
    '--video-model',
    'bytedance/seedance-2.0-mini',
    '--transition',
    'fade',
    '-a',
    '9:16',
  ]);
  assert.deepEqual(filmSettings(values), {
    aspectRatio: '9:16',
    videoModel: 'bytedance/seedance-2.0-mini',
    voice: null,
    musicModel: null,
    transition: 'fade',
  });
  assert.throws(() => filmSettings(parse(['--transition', 'wipe']).values));
});
