import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationInput, parse } from '../src/args.ts';
import { CliError, EXIT, exitCodeFor } from '../src/errors.ts';

test('image options become a generation request', () => {
  const { values, positionals } = parse([
    'image',
    'a fox',
    '-m',
    'flux',
    '--aspect',
    '16:9',
    '-n',
    '2',
    '--ref',
    'a.png',
    '--ref',
    'b.png',
  ]);
  assert.deepEqual(positionals, ['image', 'a fox']);
  assert.deepEqual(values.ref, ['a.png', 'b.png']);
  assert.deepEqual(generationInput('image', 'a fox', values), {
    kind: 'image',
    prompt: 'a fox',
    model: 'flux',
    aspectRatio: '16:9',
    count: 2,
  });
});

test('video options are checked', () => {
  const { values } = parse(['-d', '5', '--audio', '--frame-mode', 'first']);
  assert.deepEqual(generationInput('video', 'waves', values), {
    kind: 'video',
    prompt: 'waves',
    duration: 5,
    audio: true,
    frameMode: 'first',
  });
  assert.throws(
    () => generationInput('video', 'x', parse(['--frame-mode', 'odd']).values),
    (e: unknown) => e instanceof CliError && e.exitCode === EXIT.USAGE
  );
  assert.throws(
    () => generationInput('image', 'x', parse(['-d', '5']).values),
    (e: unknown) => e instanceof CliError && e.exitCode === EXIT.USAGE
  );
});

test('a prompt and sane counts are required', () => {
  assert.throws(() => generationInput('image', ' ', parse([]).values), CliError);
  assert.throws(
    () => generationInput('image', 'x', parse(['-n', '9']).values),
    /--count/
  );
  assert.throws(() => parse(['--nope']), CliError);
});

test('API error codes map to exit codes', () => {
  assert.equal(exitCodeFor('unauthorized', 401), EXIT.AUTH);
  assert.equal(exitCodeFor('insufficient_credits', 402), EXIT.CREDITS);
  assert.equal(exitCodeFor('upgrade_required', 403), EXIT.CREDITS);
  assert.equal(exitCodeFor('generation_failed', 502), EXIT.FAILED);
  assert.equal(exitCodeFor('invalid_inputs', 400), EXIT.USAGE);
  assert.equal(exitCodeFor('something', 503), EXIT.NETWORK);
});
