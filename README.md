# MakeMidas CLI: AI image and video generation for AI agents

An AI image and video generation CLI for Claude Code, Cursor, Codex, Gemini
CLI, OpenClaw and people at a terminal. One command reaches Nano Banana, GPT
Image, Seedream, Flux, Seedance, Kling, Veo, Wan and more through
[MakeMidas](https://makemidas.com), paid with your MakeMidas credits. Coding
agents run it like any other command; the
[agent skill](https://github.com/makemidas-ai/skills) teaches them the
options, and the same account works in ChatGPT and Claude through the
[MakeMidas MCP server](https://makemidas.com/developers).

```bash
npm i -g @makemidas/cli       # or: npx @makemidas/cli …
makemidas auth login          # opens the browser once
makemidas image "a lighthouse at dawn, film photo" --aspect 16:9
makemidas video "the waves roll in" --ref lighthouse.png --duration 5
```

## Commands

| Command | |
|---|---|
| `auth login [--no-browser]` | Sign in with your MakeMidas account (OAuth in the browser) |
| `auth logout` | Revoke the token and forget it |
| `auth status` | Show the signed-in account |
| `image "<prompt>"` | Generate 1–4 images and save them (`./makemidas-<id>-<n>.png`) |
| `video "<prompt>"` | Generate a clip, wait for it and save it |
| `get <id> [--wait]` | Fetch a generation and save its files |
| `list [--limit n] [--before t]` | Recent generations |
| `credits` | Balance, plan, expiring credits |
| `models [image\|video]` | Model ids, options and credit prices |
| `models <id>` | One model: options, defaults, prices and an example request |
| `estimate image\|video "<prompt>"` | Price a request without charging; takes the `image`/`video` options |

Common options: `--model`, `--aspect`, `--resolution`, `--count`, `--ref`
(file or URL, repeatable), `--style`, `--enhance`, `--duration`, `--audio`,
`--frame-mode`, `--out <dir>`, `--no-download`, `--json`. Run
`makemidas --help` for all of them.

Results go to stdout (file paths, or links with `--no-download`), progress to
stderr; `--json` gives the full generation as JSON.

Exit codes: 0 ok, 2 bad input, 3 not signed in, 4 not enough credits or a
plan limit, 5 generation failed (credits refunded), 6 network or server
error, 7 still rendering.

## Credits

Every generation spends credits at the same prices as the website. Free
accounts get 10 credits a day, the free models and watermarked images; videos
need a plan or a credit pack. `makemidas models` shows the prices;
`--quoted-credits <n>` refuses to charge anything else.

Check a price before spending, with the same options as the real command
(nothing is charged, and it exits 0 even when the balance is short):

```bash
makemidas estimate video "the waves roll in" --duration 5 --audio
makemidas models google/gemini-omni-flash   # options, defaults, prices
```

When the server can tell, errors end with a hint: try again later, change
the prompt (a safety filter refused it), or a cheaper `--model` that fits
your balance. With `--json` the same fields (`retryable`,
`requiresPromptRevision`, `suggestedModel`) stay in the error object.

## Sign-in and credentials

`auth login` opens MakeMidas in your browser, where you sign in and allow
"MakeMidas CLI" (OAuth with PKCE; the browser hands the result back to the
CLI on your own machine). Tokens are stored in
`~/.config/makemidas/credentials.json` (mode 0600; `%APPDATA%\makemidas` on
Windows). The access token lasts an hour and is refreshed automatically.
Disconnect the CLI any time in Settings → Connections.

For scripts and CI, create an API key in Settings → API keys and set
`MAKEMIDAS_API_KEY`.

Environment: `MAKEMIDAS_API_KEY`, `MAKEMIDAS_TOKEN` (an OAuth access token),
`MAKEMIDAS_BASE_URL` (server), `MAKEMIDAS_CONFIG_DIR`.

## Development

```bash
npm install
npm test          # node:test, runs the TypeScript sources directly
npm run build     # dist/cli.js
MAKEMIDAS_BASE_URL=http://localhost:4000 node dist/cli.js auth login
```

Node 20+ runs the built CLI; the tests need Node 23.6+ (type stripping).

License: MIT
