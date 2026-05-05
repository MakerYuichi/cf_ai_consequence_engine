# PROMPTS.md — AI Prompts Used in Consequence Visualizer

This file documents two categories of prompts:

1. **Runtime prompts** — prompts sent to Llama 3.3 at runtime inside the app
2. **Development prompts** — prompts used with AI coding assistant (Kiro) to build the app

---

## Part 1: Runtime Prompts (sent to Llama 3.3 via Workers AI)

---

### 1.1 System Prompt

Used as the `system` role message in **every** AI call across all routes. Sets the persona and tone for the entire app.

```
You are the Consequence Visualizer — an empathetic AI that helps people emotionally
experience the future consequences of their decisions before making them.

Your core skill is writing vivid, emotionally honest future diary entries that feel
like real human experiences — not motivational posters. You capture:
- The unexpected small moments (good and bad)
- The emotional texture of daily life after a choice
- Genuine trade-offs without propaganda
- The quiet voice of regret OR the quiet voice of relief

You are warm, perceptive, and non-judgmental. You never tell people what to choose.
You help them feel both futures so they can choose with their whole self, not just
their rational mind.

When writing diary entries: use specific dates, sensory details, real emotions, and
honest complexity. Avoid clichés. Make it feel like a real person wrote it.
```

**Design notes:**
- "Not motivational posters" is a deliberate negative constraint — LLMs default to optimistic framing without it
- "Whole self, not just rational mind" primes the model for emotional rather than analytical output
- Shared across all routes so persona stays consistent without repetition in every prompt

---

### 1.2 Decision Prompt — `POST /api/decide`

Sent as the `user` message to generate the two parallel diary entries.

```
The user is facing this decision: "{decision}"{historyContext}

Write two emotionally resonant future diary entries — one for each path. Follow this
EXACT format:

PATH_A_START
[Write a vivid, personal diary entry dated roughly one year from now where the user
DID take the action. Include specific sensory details, emotional highs and lows,
unexpected consequences, and a moment of clarity. 3-4 paragraphs. First person.]
PATH_A_END

PATH_B_START
[Write a vivid, personal diary entry dated roughly one year from now where the user
did NOT take the action. Include the quiet regrets, the unexpected upsides, the
"what ifs", and a moment of honest reflection. 3-4 paragraphs. First person.]
PATH_B_END

Make both paths feel real and human — not propaganda for one choice. Both should
have genuine trade-offs.
```

**Variables injected at runtime:**
- `{decision}` — user's raw input (e.g. `"Should I quit my job?"`)
- `{historyContext}` — optional block of past decisions from KV (see 1.2a below)

**Why delimiter markers instead of JSON:**
- Llama 3.3 reliably follows delimiter-based formats for creative prose
- Parsed server-side with regex: `/PATH_A_START\s*([\s\S]*?)\s*PATH_A_END/`
- Avoids brittle JSON parsing of multi-paragraph narrative text

**Model parameters:**
- `max_tokens: 1200` — enough for two 3–4 paragraph diary entries
- `temperature: 0.85` — creative and varied, still coherent

---

### 1.2a History Context Block

Appended to the decision prompt when the user has past decisions in KV. Enables pattern recognition across sessions.

```
User's past decisions for context:
- "Should I quit my job?" (chose: Path A) | Outcome: "Registered the business" | Accuracy: 4/5
- "Should I text my ex?" (chose: Path B) | Accuracy: 3/5
- "Should I move to NYC?" (chose: Path A)
```

**Design notes:**
- Capped at 5 most recent decisions to stay within token budget
- Allows the AI to surface behavioral patterns across decisions
- Outcome and accuracy data makes future diary entries more calibrated over time

---

### 1.3 Commitment Nudge Prompt — `POST /api/commitment`

Sent after the user picks a path and types their 24-hour commitment.

```
The user decided: "{decision}"
They chose: {userChoice}
Their 24-hour commitment: "{commitment}"

Write a brief (2-3 sentence) warm, encouraging message that:
1. Acknowledges their specific commitment
2. Reminds them WHY this step matters
3. Ends with a check-in reminder for {checkinDate}

Keep it human and grounded — not cheesy.
```

**Variables injected at runtime:**
- `{decision}` — original decision text
- `{userChoice}` — `"Path A"` or `"Path B"`
- `{commitment}` — user's typed commitment (e.g. `"Research business registration tomorrow"`)
- `{checkinDate}` — formatted date 7 days out (e.g. `"May 12"`)

**Why "not cheesy":**
- Without this constraint, LLMs default to over-enthusiastic affirmations (`"Amazing! You've got this! 🚀"`)
- Negative constraints are more effective than positive ones for tone control

**Model parameters:**
- `max_tokens: 300` — short nudge, not an essay
- `temperature: 0.8`

---

### 1.4 Check-in Reflection Prompt — `POST /api/checkin`

Sent when the user returns to report what actually happened in real life.

```
The user previously faced this decision: "{decision}"

Path A diary (if they acted): "{pathA_diary_excerpt}..."
Path B diary (if they didn't): "{pathB_diary_excerpt}..."

They chose: {userChoice}
What actually happened: "{actualOutcome}"
They rated prediction accuracy: {accuracyRating}/5

Write a warm, insightful 2-paragraph reflection. Acknowledge what the AI got right
or wrong. Find the deeper pattern. End with one forward-looking question that helps
them grow.
```

**Variables injected at runtime:**
- `{decision}` — original decision
- `{pathA_diary_excerpt}` / `{pathB_diary_excerpt}` — first 300 chars of each diary (token budget)
- `{userChoice}` — which path they chose
- `{actualOutcome}` — what the user reports actually happened
- `{accuracyRating}` — 1–5 star rating from the user

**Why include diary excerpts:**
- Grounds the reflection in what was actually predicted
- Enables specific comparisons: *"You rated this 2/5 — the AI missed the emotional toll of..."*

**Why end with a question:**
- Transforms a retrospective into a forward-looking moment
- Encourages continued engagement and self-reflection

**Model parameters:**
- `max_tokens: 500` — two thoughtful paragraphs
- `temperature: 0.75` — slightly lower for grounded, analytical reflection

---

### 1.5 Workflow Reminder Prompt — `CheckinWorkflow` (step 2)

Generated inside the Cloudflare Workflow after it wakes from its 7-day sleep. Writes a personalized reminder that surfaces in the user's Past Decisions panel.

```
A week ago, someone faced this decision: "{decision}"
They chose: {userChoice}
Their 24-hour commitment was: "{commitment}"

Today ({checkinDate}) is their scheduled check-in day. Write a warm 2-sentence
reminder that:
1. References their specific decision and commitment
2. Invites them to come back and record what actually happened

Keep it personal and grounded — not generic.
```

**Variables injected at runtime:**
- `{decision}` — original decision text (passed as Workflow payload)
- `{userChoice}` — which path they chose
- `{commitment}` — their 24-hour commitment
- `{checkinDate}` — formatted check-in date (e.g. `"Tuesday, May 12"`)

**Why this runs inside the Workflow (not the Worker):**
- The Workflow wakes up 7 days later with full context from its payload
- The reminder is generated at the moment it's needed, not stored cold for a week
- If the user never comes back, the reminder is still written and waiting in KV

**Model parameters:**
- `max_tokens: 200` — two sentences only
- `temperature: 0.75`

---

### Prompt Engineering Summary

| Decision | Rationale |
|---|---|
| Structured delimiters over JSON | Prose is harder to force into JSON; delimiters are more reliable for creative output |
| "Not propaganda" instruction | Without it, Path A (action) is always portrayed as better — LLM optimism bias |
| History context injection | Enables personalization and pattern recognition without fine-tuning |
| Negative constraints ("not cheesy", "avoid clichés") | More effective than positive instructions for tone control |
| First-person diary format | Creates emotional identification — reader becomes the protagonist |
| "One year from now" timeframe | Long enough to show real consequences; short enough to feel concrete |
| Shared system prompt | Keeps persona consistent across all routes without repetition |
| Reminder generated at wake-up time | More relevant and timely than pre-generating and storing for 7 days |

---

## Part 2: Development Prompts (used with Kiro to build this app)

---

### 2.1 Initial Project Scaffold

```
Build the complete Consequence Visualizer project for a Cloudflare Workers AI
submission. Full spec:

- Cloudflare Worker backend (src/index.js) with routes:
  POST /api/decide — generate two future diary entries using Llama 3.3
  POST /api/commitment — save user choice + 24h commitment, return nudge
  POST /api/checkin — record real outcome, return AI reflection
  GET /api/history — return all past decisions for a session

- Cloudflare KV for memory: store decision, both diary entries, user choice,
  commitment, checkin date, actual outcome, accuracy rating

- Vanilla HTML/CSS/JS frontend (public/index.html) — no framework
  - Textarea for decision input
  - Two diary cards side by side (Path A / Path B)
  - Choose path buttons
  - 24-hour commitment input
  - Past decisions history panel
  - Check-in modal with star rating

- wrangler.jsonc config with AI binding and KV namespace binding
- package.json with wrangler dev/deploy scripts

Stack: Vanilla HTML/CSS/JS frontend, Cloudflare Workers backend,
Llama 3.3 via Workers AI, Cloudflare KV for state.
Repo name must be cf_ai_consequence_engine.
```

---

### 2.2 Frontend Styling Direction

```
The frontend should feel like a thoughtful journaling app — dark theme,
serif font for the diary entries, two-column layout for the parallel paths.
Use CSS custom properties for theming. Path A accented in purple (#7c6af7),
Path B in rose (#f76a8a). Include a loading state with animated dots,
toast notifications, and a modal for the check-in flow.
No external CSS libraries — pure CSS only.
```

---

### 2.3 Adding Cloudflare Workflows for Scheduled Check-ins

```
The app currently uses a Worker + KV but has no Workflow or Durable Object.
The assignment rubric requires workflow/coordination. Add a Cloudflare Workflow
(src/checkin-workflow.js) that:

1. Is triggered when a user saves a commitment (POST /api/schedule-checkin)
2. Sleeps until the check-in date (7 days out)
3. Wakes up and calls Llama 3.3 to generate a personalized reminder
4. Writes checkinReady: true and the reminder text back to KV

Also add:
- POST /api/schedule-checkin route in index.js
- GET /api/workflow-status route for polling
- Export CheckinWorkflow from index.js (required by Workflows)
- workflows binding in wrangler.jsonc
- Frontend: call schedule-checkin after saving commitment (non-blocking)
- Frontend: show the AI reminder in the history panel when checkinReady is true

Use a deterministic workflow instance ID (checkin-{sessionId}-{decisionId})
so re-submitting never creates duplicates.
```

---

### 2.4 Fixing the SSL/Deployment URL Issue

```
The deployed Worker URL cf_ai_consequence_engine.cf-consequence.workers.dev
gives ERR_SSL_VERSION_OR_CIPHER_MISMATCH because underscores are invalid in
hostnames. Rename the worker in wrangler.jsonc from cf_ai_consequence_engine
to cf-ai-consequence-engine so the URL uses hyphens and TLS works correctly.
```

---

### 2.5 Fixing node_modules Committed to Git

```
git push failed because node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd
is 103MB and exceeds GitHub's 100MB limit. The .gitignore was created after the
initial commit so node_modules was already tracked. Remove it from git history
entirely using git filter-repo, then force push the clean history.
```
