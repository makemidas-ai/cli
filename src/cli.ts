#!/usr/bin/env node
import { Api } from './api.ts';
import { generationInput, intOption, parse, usageError } from './args.ts';
import * as commands from './commands.ts';
import { resolveBaseUrl, VERSION } from './config.ts';
import { CliError, EXIT, formatError } from './errors.ts';
import { setQuiet } from './output.ts';

const HELP = `makemidas ${VERSION}: AI images and videos from the terminal, with your MakeMidas credits

Usage:
  makemidas auth login [--no-browser]   Sign in (opens the browser)
  makemidas auth logout                 Sign out and revoke the token
  makemidas auth status                 Show the signed-in account
  makemidas image "<prompt>"            Generate images and save them
  makemidas video "<prompt>"            Generate a video and save it
  makemidas get <id>                    Fetch a generation (and save its files)
  makemidas list                        Recent generations
  makemidas credits                     Credit balance and plan
  makemidas estimate image|video "<prompt>"
                                        Price a request without charging
  makemidas models [image|video]        Models, options and credit prices
  makemidas models <id>                 One model: options, defaults, prices

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
  -d, --duration <s>      video: seconds
  --audio                 video: with sound (models that support it)
  --frame-mode <mode>     video: none | first | first_last | reference
  --no-wait               video: print the id and exit; fetch later with get

Output options (image, video, get):
  -o, --out <dir>         Where to save files (default .)
  --no-download           Print signed links (valid 1 hour) instead
  --force                 Overwrite existing files
  --wait                  get: wait until a video is done
  --timeout <min>         How long to wait for a video (default 15)

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
  makemidas models google/gemini-omni-flash

Credentials: \`auth login\`, or MAKEMIDAS_API_KEY (Settings → API keys).

Exit codes: 0 ok, 2 bad input, 3 not signed in, 4 not enough credits or plan
limit, 5 generation failed, 6 network or server error, 7 not ready yet.
`;

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
        { wait: !v['no-wait'], timeoutMin }
      );
    case 'get':
      return commands.get(api, g, rest[0], save, { wait: v.wait, timeoutMin });
    case 'list':
      return commands.list(api, g, {
        limit: intOption(v.limit, 'limit', 1, 50) ?? 20,
        before: v.before,
      });
    case 'credits':
      return commands.credits(api, g);
    case 'estimate': {
      const [kind, ...prompt] = rest;
      if (kind !== 'image' && kind !== 'video') {
        throw usageError('Use `estimate image "<prompt>"` or `estimate video "<prompt>"`.');
      }
      return commands.estimate(
        api,
        g,
        generationInput(kind, prompt.join(' '), v),
        v.ref
      );
    }
    case 'models': {
      const [arg] = rest;
      if (arg && arg !== 'image' && arg !== 'video') {
        return commands.modelDetails(api, g, arg);
      }
      const kind = v.kind ?? arg;
      if (kind && kind !== 'image' && kind !== 'video') {
        throw usageError('--kind must be image or video.');
      }
      return commands.models(api, g, kind as 'image' | 'video' | undefined);
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
