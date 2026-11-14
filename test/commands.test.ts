import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Api, type Estimate, type ModelDetails } from '../src/api.ts';
import { generationInput, parse } from '../src/args.ts';
import * as commands from '../src/commands.ts';
import { CliError, EXIT, errorHint, formatError } from '../src/errors.ts';
import { setQuiet } from '../src/output.ts';

process.env.MAKEMIDAS_API_KEY = 'mm_test';
setQuiet(true);

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

/** Run `fn` and return what it printed on stdout. */
async function stdout(fn: () => Promise<void>): Promise<string> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

const VIDEO_DETAILS: ModelDetails = {
  model: {
    kind: 'video',
    id: 'google/veo-fast',
    label: 'Veo Fast',
    family: 'veo',
    tier: 'paid',
    discount: 0.2,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durations: [4, 6, 8],
    defaultDuration: 6,
    frameModes: ['none', 'first', 'first_last'],
    frameLimits: {
      none: { min: 0, max: 0 },
      first: { min: 1, max: 1 },
      first_last: { min: 2, max: 2 },
    },
    audio: true,
    credits: [
      { resolution: '720p', creditsPerSecond: 10, creditsPerSecondWithAudio: 15 },
      { resolution: '1080p', creditsPerSecond: 20 },
    ],
  },
  example: { kind: 'video', prompt: 'A red fox', model: 'google/veo-fast' },
};

const ESTIMATE: Estimate = {
  credits: 48,
  listCredits: 60,
  discount: 0.2,
  balance: 20,
  affordable: false,
  model: 'google/veo-fast',
  request: {
    kind: 'video',
    prompt: 'waves',
    model: 'google/veo-fast',
    aspectRatio: '16:9',
    resolution: '720p',
    count: 1,
    referenceIds: [],
    enhance: false,
    duration: 4,
    frameMode: 'none',
    audio: false,
  },
  suggestedModel: 'wan/wan-fast',
};

const AFFORDABLE: Estimate = {
  ...ESTIMATE,
  balance: 100,
  affordable: true,
  suggestedModel: undefined,
};

// ---------------------------------------------------------------------------
// models <id>
// ---------------------------------------------------------------------------

test('models <id> sends the slash in the id encoded', async () => {
  const { api, calls } = apiWith(() => Response.json(VIDEO_DETAILS));
  const details = await api.modelDetails('google/veo-fast');
  assert.equal(details.model.id, 'google/veo-fast');
  assert.equal(calls[0].url.pathname, '/api/v1/models/google%2Fveo-fast');
  assert.equal(calls[0].init?.method, 'GET');
});

test('models <id> prints options, prices and the example request', async () => {
  const { api } = apiWith(() => Response.json(VIDEO_DETAILS));
  const out = await stdout(() =>
    commands.modelDetails(api, { json: false }, 'google/veo-fast')
  );
  assert.match(out, /^google\/veo-fast {2}video {2}Veo Fast\n/);
  assert.match(out, /Durations: 4\/6\/8s \(default 6s\)/);
  assert.match(out, /Resolutions: 720p, 1080p \(default 720p\)/);
  assert.match(out, /Frame modes: none, first \(1 image\), first_last \(2 images\)/);
  assert.match(out, /720p 10\/s \(15\/s with audio\), 1080p 20\/s/);
  assert.match(out, /Discount: 20% off/);
  const example = out.slice(out.indexOf('Example request:\n') + 17);
  assert.deepEqual(JSON.parse(example), VIDEO_DETAILS.example);
});

test('models <id> --json prints the raw response', async () => {
  const { api } = apiWith(() => Response.json(VIDEO_DETAILS));
  const out = await stdout(() =>
    commands.modelDetails(api, { json: true }, 'google/veo-fast')
  );
  assert.deepEqual(JSON.parse(out), VIDEO_DETAILS);
});

test('an unknown model id is a 404 with the server message', async () => {
  const { api } = apiWith(() =>
    Response.json(
      { error: { code: 'not_found', message: 'No model "acme/nope".' } },
      { status: 404 }
    )
  );
  await assert.rejects(
    commands.modelDetails(api, { json: false }, 'acme/nope'),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'not_found' &&
      e.exitCode === EXIT.USAGE &&
      e.message === 'No model "acme/nope".'
  );
});

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

test('estimate sends the same body as the generate command', async () => {
  const argv = ['-m', 'google/veo-fast', '-a', '16:9', '-d', '4', '--audio'];
  const input = generationInput('video', 'waves', parse(argv).values);

  const quote = apiWith(() => Response.json(ESTIMATE));
  await stdout(() => commands.estimate(quote.api, { json: true }, input, []));
  assert.equal(quote.calls[0].url.pathname, '/api/v1/generations/estimate');
  assert.equal(quote.calls[0].init?.method, 'POST');

  const real = apiWith(() =>
    Response.json(
      { id: 'g1', kind: 'video', status: 'done', credits: 48, outputs: [] },
      { status: 201 }
    )
  );
  await stdout(() =>
    commands.generate(
      real.api,
      { json: true },
      input,
      [],
      { out: null, force: false },
      { wait: false, timeoutMin: 1 }
    )
  );
  assert.equal(real.calls[0].url.pathname, '/api/v1/generations');
  assert.deepEqual(
    JSON.parse(String(quote.calls[0].init?.body)),
    JSON.parse(String(real.calls[0].init?.body))
  );
  assert.deepEqual(JSON.parse(String(quote.calls[0].init?.body)), {
    kind: 'video',
    prompt: 'waves',
    model: 'google/veo-fast',
    aspectRatio: '16:9',
    duration: 4,
    audio: true,
    referenceIds: [],
  });
});

test('estimate prints the price, balance and a cheaper model', async () => {
  const { api } = apiWith(() => Response.json(ESTIMATE));
  const input = generationInput('video', 'waves', parse([]).values);
  const out = await stdout(() =>
    commands.estimate(api, { json: false }, input, [])
  );
  assert.equal(
    out,
    [
      '48 credits (list 60, 20% off)',
      'Model: google/veo-fast',
      'Settings: 16:9, 720p, 4s, 1 output',
      'Balance: 20 credits, not enough',
      'Suggested model: wan/wan-fast (fits your balance)',
      '',
    ].join('\n')
  );
});

test('estimate --json prints the raw response, even when affordable', async () => {
  const affordable = { ...ESTIMATE, balance: 500, affordable: true };
  delete affordable.suggestedModel;
  const { api } = apiWith(() => Response.json(affordable));
  const input = generationInput('image', 'a fox', parse([]).values);
  const out = await stdout(() =>
    commands.estimate(api, { json: true }, input, [])
  );
  assert.deepEqual(JSON.parse(out), affordable);
});

// ---------------------------------------------------------------------------
// error hints
// ---------------------------------------------------------------------------

test('error details from the server become a hint and stay in JSON', async () => {
  const { api } = apiWith(() =>
    Response.json(
      {
        error: {
          code: 'insufficient_credits',
          message: 'This needs 48 credits; you have 20.',
          retryable: false,
          suggestedModel: 'wan/wan-fast',
        },
      },
      { status: 402 }
    )
  );
  const error = await api
    .estimate({ kind: 'video', prompt: 'x' })
    .catch((e: unknown) => e as CliError);
  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, EXIT.CREDITS);
  assert.deepEqual(error.details, {
    retryable: false,
    suggestedModel: 'wan/wan-fast',
  });
  assert.equal(
    formatError(error, false),
    'Error: This needs 48 credits; you have 20.\nHint: `--model wan/wan-fast` fits your balance.'
  );
  assert.deepEqual(JSON.parse(formatError(error, true)), {
    error: {
      code: 'insufficient_credits',
      message: 'This needs 48 credits; you have 20.',
      retryable: false,
      suggestedModel: 'wan/wan-fast',
    },
  });
});

test('hints for retryable and refused prompts; none without details', () => {
  const hint = (details: CliError['details']) =>
    errorHint(new CliError('x', EXIT.FAILED, 'generation_failed', details));
  assert.equal(hint({ retryable: true }), 'Trying again later may work.');
  assert.equal(
    hint({ retryable: false, requiresPromptRevision: true }),
    'Change the prompt or reference images before trying again.'
  );
  assert.equal(hint({ retryable: false }), undefined);
  assert.equal(formatError(new CliError('Oops', EXIT.USAGE), false), 'Error: Oops');
  assert.deepEqual(JSON.parse(formatError(new CliError('Oops', EXIT.USAGE), true)), {
    error: { code: 'ERROR', message: 'Oops' },
  });
});

// ---------------------------------------------------------------------------
// The command line, against a local mock server
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function withServer(
  handler: (req: IncomingMessage, body: string) => { status: number; json: unknown },
  fn: (baseUrl: string, seen: { path: string; body: string }[]) => Promise<void>
) {
  const seen: { path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url ?? '', body });
    const reply = handler(req, body);
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
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

test('`makemidas estimate video` exits 0 when not affordable', async () => {
  await withServer(
    () => ({ status: 200, json: ESTIMATE }),
    async (baseUrl, seen) => {
      const result = await run([
        'estimate',
        'video',
        'the waves',
        'roll in',
        '-d',
        '4',
        '--base-url',
        baseUrl,
        '--json',
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ESTIMATE);
      assert.equal(seen[0].path, '/api/v1/generations/estimate');
      assert.deepEqual(JSON.parse(seen[0].body), {
        kind: 'video',
        prompt: 'the waves roll in',
        duration: 4,
        referenceIds: [],
      });
    }
  );
});

test('`makemidas estimate` needs image or video', async () => {
  const result = await run(['estimate', 'a fox', '--base-url', 'http://127.0.0.1:9']);
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.stderr, /estimate image/);
});

test('`makemidas models <id>` fetches one model; image|video still filter', async () => {
  await withServer(
    (req) =>
      req.url?.startsWith('/api/v1/models/')
        ? { status: 200, json: VIDEO_DETAILS }
        : { status: 200, json: { models: [VIDEO_DETAILS.model] } },
    async (baseUrl, seen) => {
      const one = await run(['models', 'google/veo-fast', '--base-url', baseUrl]);
      assert.equal(one.code, 0, one.stderr);
      assert.equal(seen[0].path, '/api/v1/models/google%2Fveo-fast');
      assert.match(one.stdout, /Example request:/);

      const list = await run(['models', 'video', '--base-url', baseUrl]);
      assert.equal(list.code, 0, list.stderr);
      assert.equal(seen[1].path, '/api/v1/models?kind=video');
      assert.equal(
        list.stdout,
        'google/veo-fast  video  Veo Fast: 720p 10/s, 1080p 20/s; 4/6/8s\n'
      );
    }
  );
});

test('a server error prints its hint and keeps the fields in --json', async () => {
  const error = {
    code: 'generation_failed',
    message: 'The model refused this prompt.',
    retryable: false,
    requiresPromptRevision: true,
  };
  await withServer(
    () => ({ status: 422, json: { error } }),
    async (baseUrl) => {
      const human = await run(['estimate', 'image', 'x', '--base-url', baseUrl]);
      assert.equal(human.code, EXIT.FAILED);
      assert.equal(
        human.stderr,
        'Error: The model refused this prompt.\nHint: Change the prompt or reference images before trying again.\n'
      );
      const json = await run(['estimate', 'image', 'x', '--json', '--base-url', baseUrl]);
      assert.equal(json.code, EXIT.FAILED);
      assert.deepEqual(JSON.parse(json.stderr), { error });
    }
  );
});

// ---------------------------------------------------------------------------
// --max-credits
// ---------------------------------------------------------------------------

const DONE = { id: 'g1', kind: 'video', status: 'done', credits: 48, outputs: [] };

function quoteThenGenerate(quote: Estimate) {
  return apiWith((url) =>
    url.pathname.endsWith('/estimate')
      ? Response.json(quote)
      : Response.json(DONE, { status: 201 })
  );
}

async function generateWithMax(api: Api, max: number) {
  const input = generationInput('video', 'waves', parse([]).values);
  await stdout(() =>
    commands.generate(
      api,
      { json: true },
      input,
      [],
      { out: null, force: false },
      { wait: false, timeoutMin: 1 },
      max
    )
  );
}

test('--max-credits runs the estimated request at the quoted price', async () => {
  const { api, calls } = quoteThenGenerate(AFFORDABLE);
  await generateWithMax(api, 48);
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ['/api/v1/generations/estimate', '/api/v1/generations']
  );
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    ...AFFORDABLE.request,
    quotedCredits: 48,
  });
});

test('--max-credits stops before charging when the price is higher', async () => {
  const { api, calls } = quoteThenGenerate(AFFORDABLE);
  await assert.rejects(generateWithMax(api, 47), (error: CliError) => {
    assert.equal(error.exitCode, EXIT.CREDITS);
    assert.equal(error.code, 'over_budget');
    assert.match(error.message, /48 credits, over --max-credits 47/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('--max-credits stops when the balance is short and suggests a model', async () => {
  const { api, calls } = quoteThenGenerate(ESTIMATE);
  await assert.rejects(generateWithMax(api, 100), (error: CliError) => {
    assert.equal(error.exitCode, EXIT.CREDITS);
    assert.equal(error.code, 'insufficient_credits');
    assert.equal(error.details.suggestedModel, 'wan/wan-fast');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('`makemidas video --max-credits` uploads nothing twice and exits 0', async () => {
  await withServer(
    (req) =>
      req.url?.endsWith('/estimate')
        ? { status: 200, json: AFFORDABLE }
        : { status: 201, json: DONE },
    async (baseUrl, seen) => {
      const result = await run([
        'video',
        'waves',
        '--max-credits',
        '50',
        '--no-download',
        '--base-url',
        baseUrl,
        '--json',
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        seen.map((call) => call.path),
        ['/api/v1/generations/estimate', '/api/v1/generations']
      );
      assert.equal(JSON.parse(seen[1].body).quotedCredits, 48);
    }
  );
});

test('--max-credits and --quoted-credits together are a usage error', async () => {
  const result = await run([
    'image',
    'a fox',
    '--max-credits',
    '10',
    '--quoted-credits',
    '10',
    '--base-url',
    'http://127.0.0.1:9',
  ]);
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.stderr, /not both/);
});
