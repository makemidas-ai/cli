#!/usr/bin/env node
import { Api, type AudioTask, type EditTask, KINDS, type Kind } from './api.ts';
import {
  audioInput,
  compareModels,
  compareOptions,
  editInput,
  feedbackKind,
  generationInput,
  intOption,
  type Parsed,
  parse,
  sourceArg,
  transcriptionInput,
  usageError,
} from './args.ts';
import * as commands from './commands.ts';
import { resolveBaseUrl, VERSION } from './config.ts';
import { CliError, EXIT, formatError } from './errors.ts';
import { setQuiet } from './output.ts';

const HELP = `makemidas ${VERSION}: AI images, videos, audio, transcripts and edits from the terminal, with your MakeMidas credits

Usage:
  makemidas auth login [--no-browser]   Sign in (opens the browser)
  makemidas auth logout                 Sign out and revoke the token
  makemidas auth status                 Show the signed-in account
  makemidas image "<prompt>"            Generate images and save them
  makemidas video "<prompt>"            Generate a video and save it
  makemidas music "<prompt>"            Generate a song or track and save it
  makemidas sfx "<prompt>"              Generate a sound effect and save it
  makemidas speech "<text>"             Turn text into a voiceover (alias: voiceover)
  makemidas transcribe <file|url>       Transcribe audio or video, save the transcript
  makemidas remove-bg <image>           Remove the background (transparent WebP)
  makemidas upscale <image>             Upscale an image (--scale 1|2|4|8)
  makemidas upscale-video <video>       Upscale a clip (--resolution 1080P|2K|4K)
  makemidas compare "<prompt>" --models a,b[,c,d]
                                        One prompt on 2-4 image models
  makemidas get <id>                    Fetch a generation (and save its files)
  makemidas list                        Recent generations
  makemidas delete <id> [--yes]         Delete a generation and its files
  makemidas credits                     Credit balance and plan
  makemidas credits buy                 Links and prices for plans and credit packs
  makemidas estimate <command> "<prompt>|<file>"
                                        Price a request without charging: image,
                                        video, music, sfx, speech, transcribe,
                                        remove-bg, upscale or upscale-video
  makemidas models [<kind>]             Models, options and credit prices; kind is
                                        image, video, audio, transcription or edit
  makemidas models <id>                 One model: options, defaults, prices
  makemidas feedback "<message>"        Send feedback (--kind bug|feature|praise|other,
                                        --generation <id>)

Generation options (image, video, estimate):
  -m, --model <id>        Model id from \`makemidas models\` (default: cheapest)
  -a, --aspect <ratio>    e.g. 1:1, 16:9, 9:16
  -r, --resolution <r>    image: 1K | 2K | 4K; video: 480p | 720p | 1080p
  -n, --count <n>         Outputs, 1-4 (default 1)
  --ref <file|url>        Reference image; repeat for more. For videos: one is
                          the first frame, two are first and last frame
  --style <id>            photo, cinematic, film, anime, …
  --enhance               Let MakeMidas expand a short prompt
  --quoted-credits <n>    Refuse to charge anything else
  --max-credits <n>       Price it first, stop if it costs more, else run it
                          at exactly the quoted price (every generating command)
  -d, --duration <s>      video: seconds; music: track length (models that
                          list durations)
  --audio                 video: with sound (models that support it)
  --frame-mode <mode>     video: none | first | first_last | reference
  --no-wait               Print the id and exit instead of waiting (everything
                          but image and compare); fetch later with get

Audio options:
  --lyrics <text>         music: lyrics to sing; the prompt gives the style
  --title <title>         music: track title; transcribe: transcript name
  --instrumental          music: no vocals (models that offer it)
  --loop, --bpm <n>       sfx: a seamless loop, its tempo (40-240)
  --voice <id>            speech: a voice of the model (\`makemidas models <id>\`)
  --delivery <words>      speech, Gemini TTS: how to read it, e.g. "warm, unhurried"
  --speed <0.7-1.2>       speech, ElevenLabs: speaking speed
  --stability <0-1>       speech, ElevenLabs: varied (0) to even (1)
  --language <code>       speech, models with a language choice: auto, en, …

Transcribe and edit options:
  -m, --model <id>        transcribe: default openai/whisper-large-v2
  --format <f>            transcribe: txt (default), srt, vtt or json
  --scale <n>             upscale: 1 (sharpen), 2 (default), 4 or 8
  -r, --resolution <r>    upscale-video: 1080P, 2K (default) or 4K

Compare options:
  --models <a,b,…>        2-4 different image model ids
  -a, --aspect, --ref, --max-credits, --quoted-credits as for image

Output options (generating commands, get):
  -o, --out <dir>         Where to save files (default .); transcribe: \`-\`
                          prints the transcript itself
  --no-download           Print signed links (valid 1 hour) instead
  --force                 Overwrite existing files
  --wait                  get: wait until it is done
  --timeout <min>         How long to wait (default 15)

Delete options:
  -y, --yes               Don't ask; required when stdin is not a terminal

List options:
  --limit <n>             How many (default 20, max 50)
  --before <ISO time>     Older than this

Global:
  --json                  Machine-readable output on stdout
  --quiet                 No progress on stderr
  --base-url <url>        Server (default https://makemidas.com, or MAKEMIDAS_BASE_URL)
  -v, --version           Print the version
  -h, --help              This help

Examples:
  makemidas estimate video "the waves roll in" -d 5 --audio
  makemidas video "the waves roll in" -d 5 --audio --max-credits 60
  makemidas speech "Welcome back." --voice Kore --delivery "warm and unhurried"
  makemidas transcribe interview.m4a --format srt
  makemidas compare "a red fox in snow" --models a/one,b/two --max-credits 40
  makemidas models google/gemini-omni-flash

Credentials: \`auth login\`, or MAKEMIDAS_API_KEY (Settings → API keys).

Exit codes: 0 ok, 2 bad input, 3 not signed in, 4 not enough credits or plan
limit, 5 generation failed, 6 network or server error, 7 not ready yet.
`;

function maxCredits(v: Parsed['values']): number | undefined {
  const max = intOption(v['max-credits'], 'max-credits', 0, 1_000_000);
  if (max !== undefined && v['quoted-credits'] !== undefined) {
    throw usageError('Use --max-credits or --quoted-credits, not both.');
  }
  return max;
}

const isKind = (value: string): value is Kind =>
  (KINDS as readonly string[]).includes(value);

function audioTask(command: string): AudioTask {
  return command === 'voiceover' ? 'speech' : (command as AudioTask);
}

function editTask(command: string): EditTask {
  if (command === 'remove-bg') return 'remove-background';
  if (command === 'upscale') return 'upscale-image';
  return 'upscale-video';
}

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parse(argv);
  setQuiet(v.quiet);
  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [command, ...rest] = positionals;
  if (v.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const api = new Api(resolveBaseUrl(v['base-url']));
  const g = { json: v.json };
  const save = { out: v['no-download'] ? null : v.out, force: v.force };
  const timeoutMin = intOption(v.timeout, 'timeout', 1, 120) ?? 15;

  const wait = { wait: !v['no-wait'], timeoutMin };

  switch (command) {
    case 'auth': {
      const [sub] = rest;
      if (sub === 'login') {
        return commands.authLogin(api, g, { browser: !v['no-browser'] });
      }
      if (sub === 'logout') return commands.authLogout(api, g);
      if (sub === 'status') return commands.authStatus(api, g);
      throw usageError('Use `auth login`, `auth logout` or `auth status`.');
    }
    case 'image':
    case 'video':
      return commands.generate(
        api,
        g,
        generationInput(command, rest.join(' '), v),
        v.ref,
        save,
        wait,
        maxCredits(v)
      );
    case 'music':
    case 'sfx':
    case 'speech':
    case 'voiceover':
      return commands.generate(
        api,
        g,
        audioInput(audioTask(command), rest.join(' '), v),
        [],
        save,
        wait,
        maxCredits(v)
      );
    case 'transcribe': {
      const source = sourceArg(rest, command, 'audio or video file');
      const { input, format } = transcriptionInput(v);
      return commands.transcribe(
        api,
        g,
        input,
        source,
        format,
        save,
        wait,
        maxCredits(v)
      );
    }
    case 'remove-bg':
    case 'upscale':
    case 'upscale-video': {
      const task = editTask(command);
      const source = sourceArg(rest, command, task === 'upscale-video' ? 'video' : 'image');
      const input = editInput(task, v);
      return task === 'upscale-video'
        ? commands.generate(api, g, input, [], save, wait, maxCredits(v), {
            kind: 'video',
            source,
          })
        : commands.generate(api, g, input, [source], save, wait, maxCredits(v));
    }
    case 'compare': {
      compareOptions(v);
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        throw usageError('Give a prompt: `makemidas compare "a fox" --models a,b`.');
      }
      const quoted = intOption(v['quoted-credits'], 'quoted-credits', 0, 1_000_000);
      return commands.compare(
        api,
        g,
        {
          prompt,
          models: compareModels(v.models),
          ...(v.aspect ? { aspectRatio: v.aspect } : {}),
          ...(quoted !== undefined ? { quotedCredits: quoted } : {}),
        },
        v.ref,
        save,
        maxCredits(v)
      );
    }
    case 'delete':
      if (rest.length > 1) throw usageError('Delete one generation at a time.');
      return commands.deleteGeneration(api, g, rest[0], {
        yes: v.yes,
        interactive: Boolean(process.stdin.isTTY),
      });
    case 'feedback':
      return commands.feedback(api, g, {
        kind: feedbackKind(v.kind),
        message: rest.join(' '),
        ...(v.generation ? { generationId: v.generation } : {}),
      });
    case 'get':
      return commands.get(api, g, rest[0], save, { wait: v.wait, timeoutMin });
    case 'list':
      return commands.list(api, g, {
        limit: intOption(v.limit, 'limit', 1, 50) ?? 20,
        before: v.before,
      });
    case 'credits': {
      const [sub] = rest;
      if (!sub) return commands.credits(api, g);
      if (sub === 'buy' || sub === 'link') return commands.creditsLink(api, g);
      throw usageError('Use `credits` or `credits buy`.');
    }
    case 'estimate': {
      const [kind, ...args] = rest;
      switch (kind) {
        case 'image':
        case 'video':
          return commands.estimate(
            api,
            g,
            generationInput(kind, args.join(' '), v),
            v.ref
          );
        case 'music':
        case 'sfx':
        case 'speech':
        case 'voiceover':
          return commands.estimate(
            api,
            g,
            audioInput(audioTask(kind), args.join(' '), v),
            [],
            kind
          );
        case 'transcribe':
        case 'transcription': {
          const source = sourceArg(args, 'estimate transcribe', 'audio or video file');
          return commands.estimate(api, g, transcriptionInput(v).input, [], 'transcribe', {
            kind: 'audio',
            source,
          });
        }
        case 'remove-bg':
        case 'upscale':
        case 'upscale-video': {
          const task = editTask(kind);
          const source = sourceArg(
            args,
            `estimate ${kind}`,
            task === 'upscale-video' ? 'video' : 'image'
          );
          const input = editInput(task, v);
          return task === 'upscale-video'
            ? commands.estimate(api, g, input, [], kind, { kind: 'video', source })
            : commands.estimate(api, g, input, [source], kind);
        }
        default:
          throw usageError(
            'Use `estimate <command> …` with image, video, music, sfx, speech, transcribe, remove-bg, upscale or upscale-video.'
          );
      }
    }
    case 'models': {
      const [arg] = rest;
      if (arg && !isKind(arg)) {
        return commands.modelDetails(api, g, arg);
      }
      const kind = v.kind ?? arg;
      if (kind && !isKind(kind)) {
        throw usageError(`--kind must be ${KINDS.join(', ')}.`);
      }
      return commands.models(api, g, kind as Kind | undefined);
    }
    default:
      throw usageError(`Unknown command "${command}".`);
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(EXIT.OK),
  (error: unknown) => {
    const cli =
      error instanceof CliError
        ? error
        : new CliError(
            (error as Error)?.message ?? String(error),
            EXIT.NETWORK,
            'internal'
          );
    process.stderr.write(
      `${formatError(cli, process.argv.includes('--json'))}\n`
    );
    process.exit(cli.exitCode);
  }
);
