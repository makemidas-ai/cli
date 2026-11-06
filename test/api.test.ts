import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from '../src/api.ts';
import { CliError, EXIT } from '../src/errors.ts';

process.env.MAKEMIDAS_API_KEY = 'mm_test';

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

test('sends the API key as a bearer token', async () => {
  const { api, calls } = apiWith(() =>
    Response.json({ balance: 10, expiring: [], plan: null, paid: false })
  );
  const credits = await api.credits();
  assert.equal(credits.balance, 10);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer mm_test');
  assert.equal(calls[0].url.pathname, '/api/v1/credits');
});

test('turns API errors into exit codes', async () => {
  const { api } = apiWith(() =>
    Response.json(
      { error: { code: 'insufficient_credits', message: 'This needs 45 credits' } },
      { status: 402 }
    )
  );
  await assert.rejects(
    api.generate({ kind: 'image', prompt: 'x' }),
    (e: unknown) =>
      e instanceof CliError &&
      e.exitCode === EXIT.CREDITS &&
      e.message === 'This needs 45 credits'
  );
});

test('explains a changed price', async () => {
  const { api } = apiWith(() =>
    Response.json(
      { error: { code: 'price_changed', message: 'x', credits: 12 } },
      { status: 409 }
    )
  );
  await assert.rejects(
    api.generate({ kind: 'image', prompt: 'x', quotedCredits: 10 }),
    /--quoted-credits 12/
  );
});

test('uploads a local reference image as multipart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'makemidas-'));
  const file = join(dir, 'ref.png');
  await writeFile(file, new Uint8Array([137, 80, 78, 71]));
  const { api, calls } = apiWith(() => Response.json({ id: 'u-1' }, { status: 201 }));
  assert.equal(await api.upload(file), 'u-1');
  const body = calls[0].init?.body as FormData;
  const sent = body.get('file') as File;
  assert.equal(sent.type, 'image/png');
  assert.equal(sent.name, 'ref.png');
  await assert.rejects(api.upload(join(dir, 'notes.txt')), CliError);
});

test('asks to wait on a running generation', async () => {
  const { api, calls } = apiWith(() =>
    Response.json({ id: 'g1', status: 'running', outputs: [] })
  );
  await api.generation('g1', 40);
  assert.equal(calls[0].url.searchParams.get('wait'), '40');
});
