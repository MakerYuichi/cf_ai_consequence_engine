# ⏳ Consequence Visualizer

> An AI-powered decision-support tool that writes two future diary entries from parallel timelines — helping you emotionally *feel* the consequences of your choices before making them.

**Built with:** Cloudflare Workers · Workers AI (Llama 3.3 70B) · Cloudflare KV · Vanilla HTML/CSS/JS

---

## 🚀 Try It Now (No Setup Required)

**Live deployed app:**
👉 https://cf-ai-consequence-engine.cf-consequence.workers.dev

Open the link, type any decision you're wrestling with, and hit **Visualize →**

Example decisions to try:
- `Should I quit my job to start a business?`
- `Should I text my ex?`
- `Should I move to a new city?`

---

## What It Does

1. **Type a decision** you're stuck on
2. **AI generates two future diary entries** — one where you took the action (Path A), one where you didn't (Path B). Both are emotionally honest with real trade-offs, written in first person, set one year from now
3. **Choose a path** and commit to one small step in the next 24 hours
4. **Everything is saved** to Cloudflare KV — your decision, both diary entries, your choice, your commitment
5. **Come back later** via "Past Decisions" — rate how accurate the prediction was (1–5 stars), describe what actually happened, and get an AI reflection on what it got right or wrong

---

## Architecture

```
Browser (Vanilla HTML/CSS/JS)
        │  HTTPS
        ▼
Cloudflare Worker  (src/index.js)
  ├── POST /api/decide      → Llama 3.3 generates Path A + Path B diary entries
  ├── POST /api/commitment  → Saves user choice + 24h commitment, returns nudge
  ├── POST /api/checkin     → Records real outcome, returns AI reflection
  └── GET  /api/history     → Returns all past decisions for a session
        │                              │
        ▼                              ▼
  Cloudflare KV                 Workers AI
  (persistent memory)           (Llama 3.3-70b-instruct-fp8-fast)
```

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (single file, no framework) |
| Backend | Cloudflare Workers |
| LLM | Llama 3.3 70B via Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Memory / State | Cloudflare KV |
| Deployment | Wrangler CLI |

---

## Project Structure

```
cf_ai_consequence_engine/
├── src/
│   └── index.js       # Worker — all API routes, AI calls, KV logic
├── public/
│   └── index.html     # Frontend — Vanilla HTML/CSS/JS, single file
├── wrangler.jsonc      # Cloudflare config (Worker name, KV + AI bindings)
├── package.json        # npm scripts + wrangler dependency
├── README.md           # This file
└── PROMPTS.md          # All AI prompts used in the project
```

---

## Running Locally

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/cf_ai_consequence_engine.git
cd cf_ai_consequence_engine
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create a KV namespace

```bash
npx wrangler kv namespace create DECISIONS_KV
```

Copy the `id` from the output and paste it into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "DECISIONS_KV",
    "id": "YOUR_ID_HERE"
  }
]
```

### 4. Start the dev server

```bash
npm run dev
```

The Worker starts at `http://localhost:8787`.

Open `public/index.html` directly in your browser — it auto-detects `localhost` and routes API calls there.

> **Note:** Workers AI runs remotely even in dev mode (Wrangler proxies calls to Cloudflare's GPU infrastructure). You must be logged in with `wrangler login` for AI calls to work.

---

## Deploying

```bash
npm run deploy
```

Wrangler bundles the Worker, uploads `public/` as static assets, and outputs your live URL:
```
https://cf-ai-consequence-engine.YOUR_SUBDOMAIN.workers.dev
```

---

## API Reference

### `POST /api/decide`
Generates two future diary entries for a decision.

**Request body:**
```json
{
  "sessionId": "sess_abc123",
  "decision": "Should I quit my job to start a business?"
}
```

**Response:**
```json
{
  "decisionId": "decision_1715900000000",
  "decision": "Should I quit my job to start a business?",
  "pathA": "May 5, 2027 — One year after quitting. Some days are terrifying...",
  "pathB": "May 5, 2027 — Still at the same desk. The what-ifs whisper every Monday...",
  "checkinDate": "2026-05-12T10:00:00.000Z"
}
```

---

### `POST /api/commitment`
Saves the user's chosen path and 24-hour commitment. Returns an AI nudge.

**Request body:**
```json
{
  "sessionId": "sess_abc123",
  "decisionId": "decision_1715900000000",
  "userChoice": "Path A",
  "commitment": "Research business registration tomorrow"
}
```

**Response:**
```json
{
  "nudge": "Researching registration is exactly how big changes begin — one concrete step...",
  "checkinDate": "2026-05-12T10:00:00.000Z"
}
```

---

### `POST /api/checkin`
Records the real-world outcome and returns an AI reflection.

**Request body:**
```json
{
  "sessionId": "sess_abc123",
  "decisionId": "decision_1715900000000",
  "actualOutcome": "I registered the business and landed my first client.",
  "accuracyRating": 4
}
```

**Response:**
```json
{
  "reflection": "The AI captured the emotional arc well — the fear mixed with exhilaration...",
  "record": { "..." : "..." }
}
```

---

### `GET /api/history?sessionId=sess_abc123`
Returns all past decisions for a session, sorted newest first.

**Response:**
```json
{
  "decisions": [
    {
      "decisionId": "decision_1715900000000",
      "decision": "Should I quit my job to start a business?",
      "timestamp": "2026-05-05T10:00:00.000Z",
      "userChoice": "Path A",
      "commitment": "Research business registration tomorrow",
      "checkinDate": "2026-05-12T10:00:00.000Z",
      "actualOutcome": null,
      "accuracyRating": null
    }
  ]
}
```

---

## KV Memory Schema

Each decision is stored under key `{sessionId}:{decisionId}`:

```json
{
  "decisionId": "decision_1715900000000",
  "decision": "Should I quit my job to start a business?",
  "timestamp": "2026-05-05T10:00:00.000Z",
  "pathA_diary": "May 5, 2027 — One year after quitting...",
  "pathB_diary": "May 5, 2027 — Still at the same desk...",
  "userChoice": "Path A",
  "commitment": "Research business registration tomorrow",
  "checkinDate": "2026-05-12T10:00:00.000Z",
  "actualOutcome": null,
  "accuracyRating": null
}
```

A session index lives at `index:{sessionId}` — a JSON array of decisionIds for that user.
Sessions are identified by a random ID stored in `localStorage` (no login required).

---

## Key Features

- **Parallel future diaries** — emotionally honest prose, not a pros/cons list
- **Persistent memory** — KV stores every decision, choice, and outcome across sessions
- **Accountability loop** — return later, rate prediction accuracy, get AI reflection
- **Pattern recognition** — past decisions are injected into future prompts so the AI can notice behavioral patterns
- **24-hour commitment** — after choosing, the AI asks for one concrete next step
- **No login required** — session ID auto-generated and stored in `localStorage`

---

## License

MIT
