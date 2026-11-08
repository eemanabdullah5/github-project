# GitHub Repository AI Assistant

A local web app that lets engineering leaders ask questions about a GitHub repository's code.

1. It lists every repo your GitHub token can access, public and private. You can also paste a repo URL.
2. You pick a repo, and the app downloads and indexes its code on your machine.
3. You chat with it. Each answer starts with a plain-language summary, then gives the technical detail and the files and lines it used.

The AI can come from one of two providers, chosen with `LLM_PROVIDER` in `.env` ([DECISIONS.md](DECISIONS.md) D16):

| Provider | Speed | Privacy |
|---|---|---|
| `gemini` (default for now): Google's Gemini API | Fast, no GPU needed | ⚠️ Code from indexed repos (including private ones) and your questions are **sent to Google** |
| `ollama`: Qwen running locally in Ollama | Slow without a GPU | Code never leaves your machine |

Get senior approval before using Gemini with company code.

More detail: [PRD.md](PRD.md) (what it does), [ARCHITECTURE.md](ARCHITECTURE.md) (how it works), [DECISIONS.md](DECISIONS.md) (why).

---

## Setup

### 1. Install Node.js

You need **Node.js 22 or newer**. Check with `node --version`.

### 2. Set up the AI provider

**Option A: Gemini (default)**

Create an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). That's all you need.

**Option B: Ollama (local)**

Download Ollama from [ollama.com](https://ollama.com) and start it. It listens on `127.0.0.1:11434`. Then pull one chat model and one embedding model. On a laptop with no graphics card, use small ones:

```bash
ollama pull qwen2.5-coder:3b
ollama pull qwen3-embedding:0.6b
```

With a suitable GPU, use a bigger chat model, such as `qwen2.5-coder:7b` (about 8 GB of VRAM) or `qwen2.5-coder:14b`.

### 3. Create a GitHub token

Create a **fine-grained** personal access token at GitHub → Settings → Developer settings → Fine-grained tokens:

- **Repository access:** the repos (or all repos) you want to analyse
- **Permissions:** *Contents: Read-only* and *Metadata: Read-only*

Don't use a classic token. Reading private repos with one needs the `repo` scope, which also gives write access.

### 4. Create `.env`

Copy `.env.example` to `.env` in the project root and fill it in.

For Gemini:

```bash
GITHUB_TOKEN=github_pat_...
LLM_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
# CHAT_MODEL and EMBED_MODEL can stay empty: they default to gemini-3.6-flash and gemini-embedding-001
```

For Ollama:

```bash
GITHUB_TOKEN=github_pat_...
LLM_PROVIDER=ollama
OLLAMA_HOST=http://127.0.0.1:11434
CHAT_MODEL=qwen2.5-coder:3b
EMBED_MODEL=qwen3-embedding:0.6b
```

`.env` is git-ignored. Never commit it. If you switch provider, re-index your repos, because the two providers' embeddings can't be mixed.

### 5. Install and run

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API server runs on `127.0.0.1:3001`, and only this machine can reach either one.

For normal use without the dev server, run `npm run build`, then `npm start -w server`, and open **http://127.0.0.1:3001**.

---

## Using the app

1. **Repo Browser:** search, sort and filter your repos, or paste a URL such as `https://github.com/owner/repo`. Empty repos are hidden unless you tick *Show empty repos*.
2. **Select a repo:**
   - Not indexed yet: indexing starts, and you see Downloading → Processing → Embedding → Ready.
   - Already indexed and unchanged: the chat opens straight away.
   - Has new commits since indexing: the app asks whether to re-index.
3. **Chat:** click a starter question or type your own. Under each answer, click *Sources* to see the files and lines it used. *Clear chat* resets the conversation, and *Re-index* rebuilds the index.
4. Use the 🌙/☀️ button in the header to switch between light and dark themes.

Limits: up to 1,000 repos in the list, and up to 1,000 files or 20 MB of code per indexed repo. Only one repo can be indexed at a time.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the server and the web app in development mode |
| `npm test` | Run the server's unit tests (no network or AI provider needed) |
| `npm run typecheck` | Type-check the server and the web app |
| `npm run build` | Build both for normal use |

### Try-out scripts

Run these from the project root. They need `.env`. The last three also use the AI provider.

```bash
npx tsx server/scripts/tryGithub.ts                       # list your repos and download one zip
npx tsx server/scripts/tryIngest.ts owner/repo            # show file and chunk counts for a repo
npx tsx server/scripts/indexRepo.ts owner/repo            # index a repo and print progress
npx tsx server/scripts/ask.ts owner/repo "your question"  # ask a question on the command line
npx tsx server/scripts/evalRetrieval.ts                   # compare chunking methods (see the script)
```

---

## Test repos

Use these repos when testing, as listed in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md):

| Repo | What it tests |
|---|---|
| A small public repo you own (Python or JS/TS) | The normal path |
| A small private repo you own | Private repo support |
| A fork | Fork support |
| An empty repo | Empty repos are hidden and can't be selected |
| A large public repo (well over 20 MB) | The size limit message |

---

## Project layout

```
server/src/
  index.ts          starts the server
  app.ts            HTTP API routes
  config.ts         settings from .env and all limits
  githubClient.ts   the only file that talks to GitHub
  ingestion.ts      zip → list of useful text files
  chunking/         splits files into chunks (by function/class, or by lines)
  llm.ts            AI entry point: picks Gemini or Ollama
  llmGemini.ts      the only file that talks to Gemini
  llmOllama.ts      the only file that talks to Ollama
  vectorStore.ts    saves and searches chunks (LanceDB)
  indexer.ts        the background indexing job
  rag.ts            builds the prompt and streams the answer
  prompts.ts        the text of every instruction sent to the AI
web/src/
  App.tsx           view switching and theme
  api.ts            calls to the server
  views/            RepoBrowser and Chat
  components/       IndexProgress
data/               local indexes (git-ignored)
```

## Privacy

- The `data/` folder holds copies of the code you indexed, including private repos. Treat it as sensitive, and keep the project out of cloud-synced folders such as OneDrive.
- The GitHub token and Gemini key are read only from `.env`. They are never logged, shown in the UI or sent to the browser.
- With `LLM_PROVIDER=gemini`, indexed code and questions are sent to Google. Use `ollama` to keep everything local.
