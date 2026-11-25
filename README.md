# MakeMidas CLI: AI image and video generation for AI agents

An AI image, video and audio generation CLI for Claude Code, Cursor, Codex,
Gemini CLI, OpenClaw and people at a terminal. One command reaches Nano
Banana, GPT Image, Seedream, Flux, Seedance, Kling, Veo, Wan, Suno, Lyria,
Gemini TTS, Whisper and more through [MakeMidas](https://makemidas.com), paid
with your MakeMidas credits. It also transcribes audio, removes backgrounds,
upscales images and videos, and compares image models side by side. Coding
agents run it like any other command; the
[agent skill](https://github.com/makemidas-ai/skills) teaches them the
options, and the same account works in ChatGPT and Claude through the
[MakeMidas MCP server](https://makemidas.com/developers).

```bash
npm i -g @makemidas/cli       # or: npx @makemidas/cli …
makemidas auth login          # opens the browser once
makemidas image "a lighthouse at dawn, film photo" --aspect 16:9
makemidas video "the waves roll in" --ref lighthouse.png --duration 5
makemidas speech "Welcome back." --delivery "warm and unhurried"
makemidas transcribe interview.m4a --format srt
```

## Commands

| Command | |
|---|---|
| `auth login [--no-browser]` | Sign in with your MakeMidas account (OAuth in the browser) |
| `auth logout` | Revoke the token and forget it |
| `auth status` | Show the signed-in account |
| `image "<prompt>"` | Generate 1–4 images and save them (`./makemidas-<id>-<n>.png`) |
| `video "<prompt>"` | Generate a clip, wait for it and save it |
| `music "<prompt>"` | Generate a song or track (`--lyrics`, `--title`, `--instrumental`, `--duration`) |
| `sfx "<prompt>"` | Generate a sound effect (`--loop`, `--bpm`; the model sets the length) |
| `speech "<text>"` (alias `voiceover`) | Turn text into a voiceover (`--voice`; `--delivery` on Gemini TTS, `--speed`/`--stability` on ElevenLabs) |
| `transcribe <file\|url\|fileId>` | Upload audio or video, transcribe it and save the transcript (`--format txt\|srt\|vtt\|json`, `--title`) |
| `remove-bg <image>` | Remove the background; saves a transparent WebP |
| `upscale <image> [--scale 1\|2\|4\|8]` | Upscale an image (1 sharpens at the same size; default 2) |
| `upscale-video <video> [--resolution 1080P\|2K\|4K]` | Upscale an MP4 or MOV clip of up to 60 s (default 2K) |
| `compare "<prompt>" --models a,b[,c,d]` | One prompt on 2–4 image models, one image each |
| `film new "<brief>"`, `film get/approve/redo/download …` | Film projects: script and storyboard, approved frames and clips, an assembled film ([below](#film-projects)) |
| `get <id> [--wait]` | Fetch a generation and save its files |
| `list [--limit n] [--before t]` | Recent generations |
| `delete <id> [--yes]` | Delete a finished or failed generation and its files (no refund) |
| `credits` | Balance, plan, expiring credits |
| `credits buy` (or `credits link`) | Links to buy a plan or credit pack, with prices; opens nothing |
| `models [image\|video\|audio\|transcription\|edit]` | Model ids, options and credit prices |
| `models <id>` | One model: options, defaults, voices, prices and an example request |
| `estimate <command> "<prompt>"\|<file>` | Price a request without charging; `<command>` is `image`, `video`, `music`, `sfx`, `speech`, `transcribe`, `remove-bg`, `upscale` or `upscale-video`, with that command's options |
| `feedback "<message>" [--kind bug\|feature\|praise\|other] [--generation <id>]` | Send feedback to the MakeMidas team |

Common options: `--model`, `--aspect`, `--resolution`, `--count`, `--ref`
(file or URL, repeatable), `--style`, `--enhance`, `--duration`, `--audio`,
`--frame-mode`, `--out <dir>`, `--no-download`, `--no-wait`, `--json`. Run
`makemidas --help` for all of them. An option that belongs to another
command (say `--lyrics` on `sfx`) is a usage error.

```bash
makemidas music "lo-fi beat for studying" --instrumental
makemidas sfx "a wooden door creaks open"
makemidas voiceover "Thanks for watching." --voice Charon
makemidas transcribe https://example.com/talk.mp3 -o -     # print the text
makemidas remove-bg product.jpg
makemidas upscale photo.png --scale 4
makemidas upscale-video clip.mp4 --resolution 4K
makemidas compare "a red fox in the snow" --models <id-a>,<id-b>
makemidas delete <id> --yes
makemidas feedback "The upscale kept the noise" --kind bug --generation <id>
```

Videos, audio, transcripts and edits run in the background: the CLI waits
for them (`--timeout <min>`, default 15) unless you pass `--no-wait`, which
prints the id and exits 7; fetch it later with `makemidas get <id> --wait`.

`transcribe` sends a local file as the upload body (MP3, WAV, M4A, AAC,
FLAC, OGG, Opus, WEBM, MP4 or MOV, up to 100 MB and 60 minutes) or passes a
link for the server to download, then saves the transcript in `--format`
(default `txt`); `-o -` prints it on stdout and `--no-download` prints its
link. The model defaults to `openai/whisper-large-v2`; `-m
nvidia/nemotron-3.5-transcribe` is faster and cheaper. `upscale-video`
uploads the same way. Uploaded files are deleted after 7 days; the `fileId`
an upload printed in `--json` can be passed instead of the file.

`compare` saves each model's image and prints `<model>  <file>` per line.
Models that could not start are listed as warnings and cost nothing; it
exits 5 only when no model made an image.

`delete` asks before deleting on a terminal; in scripts and agents (stdin
not a terminal) it refuses with exit 2 unless you pass `--yes`.

Results go to stdout (file paths, or links with `--no-download`), progress to
stderr; `--json` gives the full generation as JSON.

Exit codes: 0 ok, 2 bad input (including `delete` without `--yes` when
stdin is not a terminal), 3 not signed in, 4 not enough credits, a plan
limit or busy (also over `--max-credits`), 5 generation failed (credits
refunded), 6 network or server error, 7 still rendering.

## Film projects

A film project turns a brief into a short film: a text model you choose
writes the script and a storyboard of shots, an image model draws each
shot's first frame, a video model animates it, a voiceover model reads the
narration and a music model scores it, and MakeMidas assembles the film.
Each paid stage runs only at a price you approve, so an agent can show the
price and ask before it spends.

```bash
# 1. Create it and write the storyboard (charged by the tokens it writes)
makemidas film new "A 20-second ad for our cold brew: a sleepy office wakes up" \
  --seconds 20 --aspect 9:16 --max-credits 40

# 2. Read the storyboard, change it if you like, then approve the frames
makemidas film get <id>
makemidas film update <id> --file shots.json      # optional
makemidas film approve <id> frames --quoted-credits <n> --wait

# 3. Check the frames, approve the clips, voiceover and music; it assembles
makemidas film approve <id> film --quoted-credits <n> --wait -o .

# Redo one piece, or take the pieces and cut it yourself
makemidas film redo <id> 2 clip --max-credits 40
makemidas film download <id> --pieces -o ./cut      # clips, audio, timeline.json
```

- `approve`, `write` and `redo` need `--quoted-credits <n>` (the price `film
  get` shows) or `--max-credits <n>`; without either they print the price
  and exit 2. A changed price is refused (`price_changed`) and nothing is
  charged.
- Settings: `--text-model`, `--video-model`, `-r`, `--frame-model`,
  `--speech-model`, `--voice`, `--music-model <id|none>`, `--music-prompt`,
  `--transition cut|fade|crossfade`, `--clip-audio`, `--brand <id|none>`. After
  the film is approved only the voiceover model and voice can change.
- `--wait` follows the frames, the film and the assembly (`--timeout`,
  default 15 minutes); it polls the assembly every 8 seconds, which keeps the
  render moving. A paused project (out of credits) exits 4: top up, then
  `makemidas film resume <id>`.
- `film download --pieces` saves every clip, voiceover and the music with a
  `timeline.json` (start, duration and local file of each piece) for your own
  ffmpeg cut or an agent's.
- The storyboard file for `film update --file` is a JSON list of shots (or
  `{ "shots": [...] }`), each with `prompt` and `duration`, and optionally
  `id` (keep a shot and its frame), `description`, `camera` and `voiceover`.

## Credits

Every generation spends credits at the same prices as the website. There
are no free credits: credits come from a monthly plan or a one-time credit
pack (`makemidas credits buy` prints the links and prices). `makemidas
models` shows the prices;
`--quoted-credits <n>` refuses to charge anything else.

Check a price before spending, with the same options as the real command
(nothing is charged, and it exits 0 even when the balance is short):

```bash
makemidas estimate video "the waves roll in" --duration 5 --audio
makemidas models google/gemini-omni-flash   # options, defaults, prices
```

```bash
makemidas estimate speech "Welcome back." --voice Kore
makemidas estimate transcribe interview.m4a
makemidas estimate upscale-video clip.mp4 --resolution 4K
```

Or price and run in one step: `--max-credits <n>` on any generating command
(`image`, `video`, `music`, `sfx`, `speech`, `transcribe`, `remove-bg`,
`upscale`, `upscale-video`, `compare`) estimates first and stops (exit 4, nothing charged) when the request costs
more than `n` or more than your balance. Otherwise it sends the estimated
request back at exactly the quoted price, with reference images and files
uploaded once. `compare` prices each model and quotes the total:

```bash
makemidas video "the waves roll in" --duration 5 --audio --max-credits 60
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
