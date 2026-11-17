import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Api } from '../src/api.ts';
import {
  audioInput,
  compareModels,
  editInput,
  parse,
  transcriptionInput,
} from '../src/args.ts';
import * as commands from '../src/commands.ts';
import { CliError, EXIT } from '../src/errors.ts';
import { setQuiet } from '../src/output.ts';

process.env.MAKEMIDAS_API_KEY = 'mm_test';
setQuiet(true);

const FILE_ID = '11111111-2222-4333-8444-555555555555';
const GEN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function apiWith(handler: (url: URL, init?: RequestInit) => Response) {
  const api = new Api('https://makemidas.test');
  const calls: { url: URL; init?: RequestInit }[] = [];
  api.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { api, calls };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'makemidas-'));
}

// ---------------------------------------------------------------------------
// Request bodies from the command line
// ---------------------------------------------------------------------------

test('music, sfx and speech become kind audio with their task', () => {
  const music = parse([
    '--lyrics',
    'la la',
    '--title',
    'Dawn',
    '-d',
    '120',
    '-m',
    'suno/v6',
  ]).values;
  assert.deepEqual(audioInput('music', ' lo-fi beat ', music), {
    kind: 'audio',
    task: 'music',
    prompt: 'lo-fi beat',
    model: 'suno/v6',
    lyrics: 'la la',
    title: 'Dawn',
    durationSeconds: 120,
  });
  assert.deepEqual(
    audioInput('sfx', 'door', parse(['--loop', '--bpm', '90']).values),
    { kind: 'audio', task: 'sfx', prompt: 'door', loop: true, bpm: 90 }
  );
  assert.deepEqual(
    audioInput(
      'speech',
      'Welcome back.',
      parse(['--voice', 'Kore', '--delivery', 'warm']).values
    ),
    {
      kind: 'audio',
      task: 'speech',
      prompt: 'Welcome back.',
      voice: 'Kore',
      delivery: 'warm',
    }
  );
  assert.deepEqual(
    audioInput(
      'speech',
      'Hi',
      parse(['--speed', '1.1', '--stability', '0.3']).values
    ),
    { kind: 'audio', task: 'speech', prompt: 'Hi', speed: 1.1, stability: 0.3 }
  );
});

test('audio options are checked against the task', () => {
  const usage = (e: unknown) => e instanceof CliError && e.exitCode === EXIT.USAGE;
  assert.throws(
    () => audioInput('sfx', 'x', parse(['--lyrics', 'la']).values),
    (e: unknown) => usage(e) && /--lyrics is not for `sfx`/.test((e as Error).message)
  );
  assert.throws(
    () => audioInput('music', 'x', parse(['--voice', 'Kore']).values),
    usage
  );
  assert.throws(
    () =>
      audioInput(
        'speech',
        'x',
        parse(['--delivery', 'calm', '--speed', '1']).values
      ),
    /one or the other/
  );
  assert.throws(
    () => audioInput('speech', 'x', parse(['--speed', '2']).values),
    /--speed must be a number from 0.7 to 1.2/
  );
  assert.throws(
    () => audioInput('speech', 'x', parse(['-d', '5']).values),
    usage
  );
  assert.throws(
    () => audioInput('music', 'x', parse(['--ref', 'a.png']).values),
    usage
  );
  assert.throws(() => audioInput('music', '  ', parse([]).values), usage);
});

test('edits, transcripts and comparisons check their options', () => {
  assert.deepEqual(editInput('upscale-image', parse(['--scale', '4']).values), {
    kind: 'edit',
    task: 'upscale-image',
    upscaleFactor: 4,
  });
  assert.throws(
    () => editInput('upscale-image', parse(['--scale', '3']).values),
    /--scale must be 1, 2, 4 or 8/
  );
  assert.deepEqual(
    editInput('upscale-video', parse(['-r', '4k']).values),
    { kind: 'edit', task: 'upscale-video', resolution: '4K' }
  );
  assert.throws(
    () => editInput('upscale-video', parse(['-r', '720p']).values),
    /1080P, 2K or 4K/
  );
  assert.throws(
    () => editInput('remove-background', parse(['--scale', '2']).values),
    /--scale is not for `remove-bg`/
  );
  assert.deepEqual(transcriptionInput(parse(['--title', 'Talk']).values), {
    input: {
      kind: 'transcription',
      model: 'openai/whisper-large-v2',
      title: 'Talk',
    },
    format: 'txt',
  });
  assert.throws(
    () => transcriptionInput(parse(['--format', 'docx']).values),
    /txt, srt, vtt or json/
  );
  assert.deepEqual(compareModels(' a/one, b/two '), ['a/one', 'b/two']);
  assert.throws(() => compareModels('a/one'), /2 to 4/);
  assert.throws(() => compareModels('a,b,c,d,e'), /2 to 4/);
  assert.throws(() => compareModels('a,a'), /different/);
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

test('audio uploads send the raw file with its type, length and name', async () => {
  const dir = await tempDir();
  const file = join(dir, 'my talk é.mp3');
  await writeFile(file, new Uint8Array([1, 2, 3, 4, 5]));
  const { api, calls } = apiWith(() =>
    Response.json(
      { fileId: FILE_ID, durationSeconds: 12, credits: 1 },
      { status: 201 }
    )
  );
  const upload = await api.mediaUpload('audio', file);
  assert.equal(upload.fileId, FILE_ID);
  assert.equal(calls[0].url.pathname, '/api/v1/audio-uploads');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'audio/mpeg');
  assert.equal(headers['Content-Length'], '5');
  assert.equal(headers['X-File-Name'], encodeURIComponent('my talk é.mp3'));
  assert.equal(headers.Authorization, 'Bearer mm_test');
  assert.deepEqual([...(calls[0].init?.body as Uint8Array)], [1, 2, 3, 4, 5]);
});

test('a link is sent as { url }; video uploads take MP4 or MOV only', async () => {
  const { api, calls } = apiWith(() =>
    Response.json(
      { fileId: FILE_ID, durationSeconds: 8, credits: 32 },
      { status: 201 }
    )
  );
  await api.mediaUpload('video', 'https://example.test/clip.mp4');
  assert.equal(calls[0].url.pathname, '/api/v1/video-uploads');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    url: 'https://example.test/clip.mp4',
  });

  const dir = await tempDir();
  const mov = join(dir, 'clip.MOV');
  await writeFile(mov, new Uint8Array([0]));
  await api.mediaUpload('video', mov);
  assert.equal(
    (calls[1].init?.headers as Record<string, string>)['Content-Type'],
    'video/quicktime'
  );
  await assert.rejects(
    api.mediaUpload('video', join(dir, 'song.mp3')),
    (e: unknown) =>
      e instanceof CliError &&
      e.exitCode === EXIT.USAGE &&
      /MP4 or MOV/.test(e.message)
  );
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// The command line, against a local mock server
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type Reply =
  | { status: number; json: unknown }
  | { status: number; bytes: string | Uint8Array; type: string };

async function withServer(
  handler: (req: Seen, baseUrl: string) => Reply,
  fn: (baseUrl: string, seen: Seen[]) => Promise<void>
) {
  const seen: Seen[] = [];
  let baseUrl = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const entry: Seen = {
      method: req.method ?? 'GET',
      path: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    seen.push(entry);
    const reply = handler(entry, baseUrl);
    if ('json' in reply) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    } else {
      res.writeHead(reply.status, { 'Content-Type': reply.type });
      res.end(reply.bytes);
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, seen);
  } finally {
    server.close();
  }
}

function run(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, MAKEMIDAS_API_KEY: 'mm_test' } },
      (error, stdout, stderr) =>
        done({ code: error ? Number(error.code) : 0, stdout, stderr })
    );
  });
}

const json = (status: number, body: unknown): Reply => ({ status, json: body });
const body = (seen: Seen) => JSON.parse(seen.body.toString('utf8'));

function generation(kind: string, status: string, outputs: unknown[] = []) {
  return {
    id: GEN_ID,
    kind,
    model: 'acme/model',
    prompt: '',
    params: {},
    count: 1,
    credits: 12,
    status,
    watermarked: false,
    outputs,
    createdAt: '2026-11-17T00:00:00Z',
    webUrl: 'https://makemidas.test/g',
  };
}

test('`makemidas music` waits for the track and saves it as MP3', async () => {
  const out = await tempDir();
  await withServer(
    (req, baseUrl) => {
      if (req.method === 'POST') return json(202, generation('audio', 'running'));
      if (req.path.startsWith('/api/v1/generations/')) {
        return json(
          200,
          generation('audio', 'done', [
            { status: 'done', url: `${baseUrl}/files/take.mp3` },
          ])
        );
      }
      return { status: 200, bytes: 'ID3', type: 'audio/mpeg' };
    },
    async (baseUrl, seen) => {
      const result = await run([
        'music',
        'lo-fi',
        'beat',
        '--lyrics',
        'la la',
        '--title',
        'Dawn',
        '-o',
        out,
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].path, '/api/v1/generations');
      assert.deepEqual(body(seen[0]), {
        kind: 'audio',
        task: 'music',
        prompt: 'lo-fi beat',
        lyrics: 'la la',
        title: 'Dawn',
      });
      assert.equal(seen[1].path, `/api/v1/generations/${GEN_ID}?wait=40`);
      const file = join(out, 'makemidas-aaaaaaaa-1.mp3');
      assert.equal(result.stdout, `${file}\n`);
      assert.equal(await readFile(file, 'utf8'), 'ID3');
    }
  );
});

test('`makemidas voiceover` is speech; --no-wait exits 7 with the id', async () => {
  await withServer(
    () => json(202, generation('audio', 'running')),
    async (baseUrl, seen) => {
      const result = await run([
        'voiceover',
        'Welcome back.',
        '--voice',
        'Kore',
        '--delivery',
        'warm and unhurried',
        '--no-wait',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, EXIT.NOT_READY, result.stderr);
      assert.match(result.stderr, new RegExp(`makemidas get ${GEN_ID} --wait`));
      assert.equal(seen.length, 1);
      assert.deepEqual(body(seen[0]), {
        kind: 'audio',
        task: 'speech',
        prompt: 'Welcome back.',
        voice: 'Kore',
        delivery: 'warm and unhurried',
      });
    }
  );
});

test('`makemidas sfx` keeps the server hint for a cheaper model', async () => {
  const error = {
    code: 'insufficient_credits',
    message: 'This needs 2 credits; you have 1.',
    retryable: false,
    suggestedModel: 'suno/v6-sounds',
  };
  await withServer(
    () => json(402, { error }),
    async (baseUrl, seen) => {
      const human = await run([
        'sfx',
        'a door creaks',
        '--loop',
        '--bpm',
        '90',
        '--quiet',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(human.code, EXIT.CREDITS);
      assert.equal(
        human.stderr,
        'Error: This needs 2 credits; you have 1.\nHint: `--model suno/v6-sounds` fits your balance.\n'
      );
      assert.deepEqual(body(seen[0]), {
        kind: 'audio',
        task: 'sfx',
        prompt: 'a door creaks',
        loop: true,
        bpm: 90,
      });
      const machine = await run(['sfx', 'x', '--json', '--quiet', '--base-url', baseUrl]);
      assert.deepEqual(JSON.parse(machine.stderr), { error });
    }
  );
});

test('`makemidas speech --max-credits` prices first and sends the quote', async () => {
  const request = {
    kind: 'audio',
    task: 'speech',
    prompt: 'Hi',
    model: 'google/gemini-3.8-flash-tts',
    count: 1,
    referenceIds: [],
    enhance: false,
    voice: 'Kore',
  };
  await withServer(
    (req) =>
      req.path.endsWith('/estimate')
        ? json(200, {
            credits: 1,
            listCredits: 1,
            discount: 0,
            balance: 50,
            affordable: true,
            model: request.model,
            request,
          })
        : json(202, generation('audio', 'running')),
    async (baseUrl, seen) => {
      const result = await run([
        'speech',
        'Hi',
        '--max-credits',
        '5',
        '--no-wait',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, EXIT.NOT_READY, result.stderr);
      assert.deepEqual(
        seen.map((s) => s.path),
        ['/api/v1/generations/estimate', '/api/v1/generations']
      );
      assert.deepEqual(body(seen[1]), { ...request, quotedCredits: 1 });
    }
  );
});

function transcriptServer(baseUrlRef: { value: string }) {
  return (req: Seen, baseUrl: string): Reply => {
    baseUrlRef.value = baseUrl;
    if (req.path === '/api/v1/audio-uploads') {
      return json(201, {
        fileId: FILE_ID,
        fileName: 'talk.m4a',
        durationSeconds: 75,
        credits: 2,
      });
    }
    if (req.path === '/api/v1/generations') {
      return json(202, generation('transcription', 'running'));
    }
    if (req.path.startsWith('/api/v1/generations/')) {
      return json(
        200,
        generation('transcription', 'done', [
          {
            status: 'done',
            url: `${baseUrl}/files/t`,
            transcript: { preview: 'Hello', durationSeconds: 75, speakers: 2 },
            downloads: {
              txt: `${baseUrl}/files/t?format=txt&download=1`,
              srt: `${baseUrl}/files/t?format=srt&download=1`,
              vtt: `${baseUrl}/files/t?format=vtt&download=1`,
              json: `${baseUrl}/files/t?format=json&download=1`,
            },
          },
        ])
      );
    }
    const format = new URL(req.path, baseUrl).searchParams.get('format');
    return {
      status: 200,
      bytes: format === 'srt' ? '1\n00:00:00,000 --> 00:00:01,000\nHello\n' : 'Hello\n',
      type: 'text/plain',
    };
  };
}

test('`makemidas transcribe` uploads the raw file, waits and saves the SRT', async () => {
  const dir = await tempDir();
  const audio = join(dir, 'talk.m4a');
  await writeFile(audio, new Uint8Array([9, 9, 9]));
  const ref = { value: '' };
  await withServer(transcriptServer(ref), async (baseUrl, seen) => {
    const result = await run([
      'transcribe',
      audio,
      '--format',
      'srt',
      '--title',
      'Talk',
      '-o',
      dir,
      '--base-url',
      baseUrl,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const upload = seen[0];
    assert.equal(upload.path, '/api/v1/audio-uploads');
    assert.equal(upload.headers['content-type'], 'audio/mp4');
    assert.equal(upload.headers['content-length'], '3');
    assert.equal(upload.headers['x-file-name'], 'talk.m4a');
    assert.deepEqual([...upload.body], [9, 9, 9]);
    assert.deepEqual(body(seen[1]), {
      kind: 'transcription',
      model: 'openai/whisper-large-v2',
      title: 'Talk',
      fileId: FILE_ID,
    });
    assert.equal(seen[3].path, '/files/t?format=srt&download=1');
    const file = join(dir, 'makemidas-aaaaaaaa-1.srt');
    assert.equal(result.stdout, `${file}\n`);
    assert.match(await readFile(file, 'utf8'), /--> 00:00:01,000/);
  });
});

test('`makemidas transcribe <url> -o -` sends { url } and prints the text', async () => {
  const ref = { value: '' };
  await withServer(transcriptServer(ref), async (baseUrl, seen) => {
    const result = await run([
      'transcribe',
      'https://example.test/talk.mp3',
      '-m',
      'nvidia/nemotron-3.5-transcribe',
      '-o',
      '-',
      '--base-url',
      baseUrl,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(seen[0]), { url: 'https://example.test/talk.mp3' });
    assert.equal(body(seen[1]).model, 'nvidia/nemotron-3.5-transcribe');
    assert.equal(seen[3].path, '/files/t?format=txt&download=1');
    assert.equal(result.stdout, 'Hello\n');
  });
});

test('`makemidas transcribe --no-download` prints the format link', async () => {
  const ref = { value: '' };
  await withServer(transcriptServer(ref), async (baseUrl, seen) => {
    const result = await run([
      'transcribe',
      FILE_ID,
      '--format',
      'vtt',
      '--no-download',
      '--base-url',
      baseUrl,
    ]);
    assert.equal(result.code, 0, result.stderr);
    // A fileId from an earlier upload is used as it is.
    assert.equal(seen[0].path, '/api/v1/generations');
    assert.equal(body(seen[0]).fileId, FILE_ID);
    assert.equal(result.stdout, `${baseUrl}/files/t?format=vtt&download=1\n`);
    assert.equal(seen.length, 2);
  });
});

test('`makemidas remove-bg` uploads the image as a reference', async () => {
  const dir = await tempDir();
  const image = join(dir, 'shoe.png');
  await writeFile(image, new Uint8Array([137, 80, 78, 71]));
  await withServer(
    (req, baseUrl) => {
      if (req.path === '/api/v1/uploads') return json(201, { id: FILE_ID });
      if (req.path === '/api/v1/generations') {
        return json(
          201,
          generation('edit', 'done', [
            { status: 'done', url: `${baseUrl}/files/cut.webp` },
          ])
        );
      }
      return { status: 200, bytes: 'RIFF', type: 'image/webp' };
    },
    async (baseUrl, seen) => {
      const result = await run(['remove-bg', image, '-o', dir, '--base-url', baseUrl]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(String(seen[0].headers['content-type']), /^multipart\/form-data/);
      assert.deepEqual(body(seen[1]), {
        kind: 'edit',
        task: 'remove-background',
        referenceIds: [FILE_ID],
      });
      assert.equal(result.stdout, `${join(dir, 'makemidas-aaaaaaaa-1.webp')}\n`);
    }
  );
});

test('`makemidas upscale --scale 4` and a bad scale', async () => {
  const dir = await tempDir();
  const image = join(dir, 'a.jpg');
  await writeFile(image, new Uint8Array([255, 216]));
  await withServer(
    (req) =>
      req.path === '/api/v1/uploads'
        ? json(201, { id: FILE_ID })
        : json(202, generation('edit', 'running')),
    async (baseUrl, seen) => {
      const result = await run([
        'upscale',
        image,
        '--scale',
        '4',
        '--no-wait',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, EXIT.NOT_READY, result.stderr);
      assert.deepEqual(body(seen[1]), {
        kind: 'edit',
        task: 'upscale-image',
        upscaleFactor: 4,
        referenceIds: [FILE_ID],
      });
      const bad = await run(['upscale', image, '--scale', '3', '--base-url', baseUrl]);
      assert.equal(bad.code, EXIT.USAGE);
      assert.equal(seen.length, 2);
    }
  );
});

test('`makemidas upscale-video` uploads the raw video and sends its fileId', async () => {
  const dir = await tempDir();
  const clip = join(dir, 'clip.mp4');
  await writeFile(clip, new Uint8Array([0, 0, 0, 24]));
  await withServer(
    (req) =>
      req.path === '/api/v1/video-uploads'
        ? json(201, { fileId: FILE_ID, durationSeconds: 6, credits: 24 })
        : json(202, generation('edit', 'running')),
    async (baseUrl, seen) => {
      const result = await run([
        'upscale-video',
        clip,
        '-r',
        '4K',
        '--no-wait',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, EXIT.NOT_READY, result.stderr);
      assert.equal(seen[0].path, '/api/v1/video-uploads');
      assert.equal(seen[0].headers['content-type'], 'video/mp4');
      assert.equal(seen[0].headers['content-length'], '4');
      assert.equal(seen[0].headers['x-file-name'], 'clip.mp4');
      assert.deepEqual(body(seen[1]), {
        kind: 'edit',
        task: 'upscale-video',
        resolution: '4K',
        fileId: FILE_ID,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

function comparison(baseUrl: string) {
  return {
    credits: 15,
    generations: ['a/one', 'b/two'].map((model, i) => ({
      ...generation('image', 'done', [
        { status: 'done', url: `${baseUrl}/files/${i}.png` },
      ]),
      id: `${i}${GEN_ID.slice(1)}`,
      model,
    })),
    failed: [],
  };
}

const estimateFor = (model: string, credits: number, balance = 100) => ({
  credits,
  listCredits: credits,
  discount: 0,
  balance,
  affordable: credits <= balance,
  model,
  request: {
    kind: 'image',
    prompt: 'fox',
    model,
    count: 1,
    referenceIds: [],
    enhance: false,
  },
});

test('`makemidas compare` sends the models and saves one image each', async () => {
  const dir = await tempDir();
  await withServer(
    (req, baseUrl) =>
      req.path === '/api/v1/generations/compare'
        ? json(201, comparison(baseUrl))
        : { status: 200, bytes: 'PNG', type: 'image/png' },
    async (baseUrl, seen) => {
      const result = await run([
        'compare',
        'a red fox',
        '--models',
        'a/one,b/two',
        '-a',
        '16:9',
        '--quoted-credits',
        '15',
        '-o',
        dir,
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(seen[0]), {
        prompt: 'a red fox',
        models: ['a/one', 'b/two'],
        aspectRatio: '16:9',
        quotedCredits: 15,
        referenceIds: [],
      });
      assert.equal(
        result.stdout,
        `a/one  ${join(dir, 'makemidas-0aaaaaaa-1.png')}\nb/two  ${join(dir, 'makemidas-1aaaaaaa-1.png')}\n`
      );
    }
  );
});

test('`makemidas compare --max-credits` prices each model and quotes the total', async () => {
  await withServer(
    (req, baseUrl) => {
      if (req.path.endsWith('/estimate')) {
        const { model } = body(req);
        return json(200, estimateFor(model, model === 'a/one' ? 5 : 10));
      }
      return json(201, comparison(baseUrl));
    },
    async (baseUrl, seen) => {
      const over = await run([
        'compare',
        'fox',
        '--models',
        'a/one,b/two',
        '--max-credits',
        '14',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(over.code, EXIT.CREDITS);
      assert.match(over.stderr, /costs 15 credits .*over --max-credits 14/);
      assert.equal(seen.length, 2);
      assert.deepEqual(body(seen[0]), {
        kind: 'image',
        prompt: 'fox',
        model: 'a/one',
        count: 1,
        referenceIds: [],
      });

      const ok = await run([
        'compare',
        'fox',
        '--models',
        'a/one,b/two',
        '--max-credits',
        '15',
        '--no-download',
        '--json',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(ok.code, 0, ok.stderr);
      const sent = seen.find((s) => s.path === '/api/v1/generations/compare');
      assert.ok(sent);
      assert.equal(body(sent).quotedCredits, 15);
      assert.equal(JSON.parse(ok.stdout).generations.length, 2);
    }
  );
});

test('`makemidas compare` needs --models and refuses --model', async () => {
  const none = await run(['compare', 'fox', '--base-url', 'http://127.0.0.1:9']);
  assert.equal(none.code, EXIT.USAGE);
  assert.match(none.stderr, /2 to 4/);
  const one = await run([
    'compare',
    'fox',
    '--models',
    'a,b',
    '-m',
    'a',
    '--base-url',
    'http://127.0.0.1:9',
  ]);
  assert.equal(one.code, EXIT.USAGE);
  assert.match(one.stderr, /--model is not for `compare`/);
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test('`makemidas delete` refuses without --yes when stdin is not a terminal', async () => {
  await withServer(
    () => json(200, { id: GEN_ID, deleted: true }),
    async (baseUrl, seen) => {
      const refused = await run(['delete', GEN_ID, '--base-url', baseUrl]);
      assert.equal(refused.code, EXIT.USAGE);
      assert.match(refused.stderr, /--yes/);
      assert.equal(seen.length, 0);

      const done = await run(['delete', GEN_ID, '--yes', '--base-url', baseUrl]);
      assert.equal(done.code, 0, done.stderr);
      assert.equal(seen[0].method, 'DELETE');
      assert.equal(seen[0].path, `/api/v1/generations/${GEN_ID}`);
      assert.equal(done.stdout, `Deleted ${GEN_ID}.\n`);
    }
  );
});

test('delete asks on a terminal and sends nothing on no', async () => {
  const { api, calls } = apiWith(() => Response.json({ id: GEN_ID, deleted: true }));
  const questions: string[] = [];
  await assert.rejects(
    commands.deleteGeneration(api, { json: false }, GEN_ID, {
      yes: false,
      interactive: true,
      confirm: async (q) => {
        questions.push(q);
        return false;
      },
    }),
    (e: unknown) => e instanceof CliError && e.code === 'cancelled'
  );
  assert.equal(calls.length, 0);
  assert.match(questions[0], new RegExp(GEN_ID));

  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await commands.deleteGeneration(api, { json: false }, GEN_ID, {
      yes: false,
      interactive: true,
      confirm: async () => true,
    });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(calls[0].init?.method, 'DELETE');
});

test('a running generation cannot be deleted (409 busy)', async () => {
  await withServer(
    () =>
      json(409, {
        error: {
          code: 'busy',
          message: 'This generation is still running',
          retryable: true,
        },
      }),
    async (baseUrl) => {
      const result = await run(['delete', GEN_ID, '-y', '--base-url', baseUrl]);
      assert.equal(result.code, EXIT.CREDITS);
      assert.equal(
        result.stderr,
        'Error: This generation is still running\nHint: Trying again later may work.\n'
      );
    }
  );
});

// ---------------------------------------------------------------------------
// feedback / credits buy / models / estimate
// ---------------------------------------------------------------------------

test('`makemidas feedback` sends the kind, message and generation', async () => {
  await withServer(
    () => json(202, { received: true }),
    async (baseUrl, seen) => {
      const result = await run([
        'feedback',
        'The',
        'upscale kept the noise',
        '--kind',
        'bug',
        '--generation',
        GEN_ID,
        '--base-url',
        baseUrl,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].path, '/api/v1/feedback');
      assert.deepEqual(body(seen[0]), {
        kind: 'bug',
        message: 'The upscale kept the noise',
        generationId: GEN_ID,
      });
      const bad = await run(['feedback', 'x', '--kind', 'rant', '--base-url', baseUrl]);
      assert.equal(bad.code, EXIT.USAGE);
      const empty = await run(['feedback', '--base-url', baseUrl]);
      assert.equal(empty.code, EXIT.USAGE);
      assert.equal(seen.length, 1);
    }
  );
});

const PURCHASE = {
  url: 'https://makemidas.test/pricing?tab=plans',
  plansUrl: 'https://makemidas.test/pricing?tab=plans',
  packsUrl: 'https://makemidas.test/pricing?tab=packs',
  billingUrl: 'https://makemidas.test/settings/billing',
  purchasable: true,
  balance: 3,
  plan: null,
  plans: [
    {
      id: 'pro',
      name: 'Pro',
      priceUsd: 50,
      interval: 'month',
      monthlyCredits: 5500,
      concurrency: 4,
      maxOutputs: 4,
      popular: true,
      current: false,
    },
  ],
  packs: [
    { id: 'p10', priceUsd: 10, credits: 1000, subscriberCredits: 1250, popular: false },
  ],
};

test('`makemidas credits buy` prints the links and prices', async () => {
  await withServer(
    () => json(200, PURCHASE),
    async (baseUrl, seen) => {
      const result = await run(['credits', 'buy', '--base-url', baseUrl]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].path, '/api/v1/credits/purchase-link');
      const lines = result.stdout.split('\n');
      assert.equal(lines[0], PURCHASE.url);
      assert.match(result.stdout, /Pro: \$50\/month, 5500 credits a month/);
      assert.match(result.stdout, /\$10: 1000 credits \(1250 with a plan\)/);
      const link = await run(['credits', 'link', '--json', '--base-url', baseUrl]);
      assert.deepEqual(JSON.parse(link.stdout), PURCHASE);
      const bad = await run(['credits', 'sell', '--base-url', baseUrl]);
      assert.equal(bad.code, EXIT.USAGE);
    }
  );
});

test('`makemidas models audio|transcription|edit` filter by the new kinds', async () => {
  const models = {
    audio: {
      kind: 'audio',
      id: 'google/gemini-3.8-flash-tts',
      label: 'Gemini 3.8 Flash TTS',
      family: 'gemini',
      tier: 'paid',
      discount: 0,
      task: 'speech',
      durations: [],
      defaultDuration: null,
      lyrics: false,
      instrumental: false,
      loop: false,
      creditsPer1kChars: 10,
    },
    transcription: {
      kind: 'transcription',
      id: 'openai/whisper-large-v2',
      label: 'Whisper Large v2',
      family: 'whisper',
      tier: 'paid',
      discount: 0,
      creditsPerHour: 50,
      maxDurationSeconds: 3600,
      maxBytes: 104857600,
      formats: 'MP3',
      speakers: true,
      languages: 99,
      outputFormats: ['json', 'txt', 'srt', 'vtt'],
    },
    edit: {
      kind: 'edit',
      id: 'kie/video-upscale',
      label: 'Kie Video Upscaler',
      family: 'kie',
      tier: 'paid',
      discount: 0,
      task: 'upscale-video',
      input: 'fileId',
      limits: '60 s',
      creditsPerSecond: [
        { resolution: '1080P', creditsPerSecond: 2 },
        { resolution: '4K', creditsPerSecond: 8 },
      ],
      watermarked: false,
    },
  } as const;
  await withServer(
    (req, baseUrl) => {
      const kind = new URL(req.path, baseUrl).searchParams.get('kind') as keyof typeof models;
      return json(200, { models: [models[kind]] });
    },
    async (baseUrl, seen) => {
      const expected = {
        audio: 'google/gemini-3.8-flash-tts  audio speech  Gemini 3.8 Flash TTS: 10 per 1,000 characters\n',
        transcription: 'openai/whisper-large-v2  transcription  Whisper Large v2: 50 per hour of audio\n',
        edit: 'kie/video-upscale  edit upscale-video  Kie Video Upscaler: 1080P 2/s, 4K 8/s\n',
      };
      for (const kind of ['audio', 'transcription', 'edit'] as const) {
        const result = await run(['models', kind, '--base-url', baseUrl]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, expected[kind]);
      }
      assert.deepEqual(
        seen.map((s) => s.path),
        [
          '/api/v1/models?kind=audio',
          '/api/v1/models?kind=transcription',
          '/api/v1/models?kind=edit',
        ]
      );
      const flag = await run(['models', '--kind', 'edit', '--base-url', baseUrl]);
      assert.equal(flag.code, 0, flag.stderr);
      const bad = await run(['models', '--kind', 'nope', '--base-url', baseUrl]);
      assert.equal(bad.code, EXIT.USAGE);
    }
  );
});

test('`makemidas estimate` prices audio, transcripts and edits', async () => {
  const dir = await tempDir();
  const clip = join(dir, 'clip.mov');
  await writeFile(clip, new Uint8Array([1]));
  await withServer(
    (req) => {
      if (req.path === '/api/v1/video-uploads') {
        return json(201, { fileId: FILE_ID, durationSeconds: 5, credits: 20 });
      }
      const sent = body(req);
      return json(200, {
        ...estimateFor(sent.model ?? 'acme/model', 7),
        request: { ...sent, model: 'acme/model', count: 1, referenceIds: [], enhance: false },
      });
    },
    async (baseUrl, seen) => {
      const speech = await run([
        'estimate',
        'speech',
        'Hello there',
        '--voice',
        'Kore',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(speech.code, 0, speech.stderr);
      assert.deepEqual(body(seen[0]), {
        kind: 'audio',
        task: 'speech',
        prompt: 'Hello there',
        voice: 'Kore',
      });
      assert.match(speech.stdout, /^7 credits\n/);
      assert.match(speech.stdout, /Settings: speech, voice Kore\n/);
      assert.match(speech.stderr, /`makemidas speech` and the same options plus --max-credits 7/);

      const transcript = await run([
        'estimate',
        'transcribe',
        FILE_ID,
        '--base-url',
        baseUrl,
      ]);
      assert.equal(transcript.code, 0, transcript.stderr);
      assert.deepEqual(body(seen[1]), {
        kind: 'transcription',
        model: 'openai/whisper-large-v2',
        fileId: FILE_ID,
      });

      const upscale = await run([
        'estimate',
        'upscale-video',
        clip,
        '-r',
        '1080p',
        '--json',
        '--base-url',
        baseUrl,
      ]);
      assert.equal(upscale.code, 0, upscale.stderr);
      assert.equal(seen[2].path, '/api/v1/video-uploads');
      assert.deepEqual(body(seen[3]), {
        kind: 'edit',
        task: 'upscale-video',
        resolution: '1080P',
        fileId: FILE_ID,
      });
      assert.equal(seen.length, 4);
    }
  );
});
