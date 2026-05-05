/**
 * Consequence Visualizer — Cloudflare Worker
 *
 * Routes:
 *   POST /api/decide           — Generate two future diary entries for a decision
 *   POST /api/checkin          — Follow up on a past decision / record outcome
 *   GET  /api/history          — Retrieve all past decisions for a session
 *   POST /api/commitment       — Save a 24-hour commitment to a decision
 *   POST /api/schedule-checkin — Launch a Workflow to send a reminder on check-in date
 *   GET  /api/workflow-status  — Poll the status of a running Workflow instance
 *
 * Bindings (wrangler.jsonc):
 *   AI               — Workers AI (Llama 3.3)
 *   DECISIONS_KV     — KV namespace for persistent memory
 *   CHECKIN_WORKFLOW — Cloudflare Workflow for durable scheduled check-ins
 */

export { CheckinWorkflow } from "./checkin-workflow.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/decide" && request.method === "POST") {
        return await handleDecide(request, env);
      }
      if (url.pathname === "/api/checkin" && request.method === "POST") {
        return await handleCheckin(request, env);
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        return await handleHistory(request, env);
      }
      if (url.pathname === "/api/commitment" && request.method === "POST") {
        return await handleCommitment(request, env);
      }
      if (url.pathname === "/api/schedule-checkin" && request.method === "POST") {
        return await handleScheduleCheckin(request, env);
      }
      if (url.pathname === "/api/workflow-status" && request.method === "GET") {
        return await handleWorkflowStatus(request, env);
      }
      if (url.pathname === "/api/debug" && request.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return jsonResponse({ error: "sessionId required" }, 400);
        const indexKey = `index:${sessionId}`;
        const ids = await env.DECISIONS_KV.get(indexKey, "json") ?? [];
        const records = await Promise.all(ids.map(id => env.DECISIONS_KV.get(`${sessionId}:${id}`, "json")));
        return jsonResponse({ ids, records });
      }

      // Serve index.html for root and any non-API path
      if (!url.pathname.startsWith("/api/")) {
        const html = await env.ASSETS.fetch(new Request("https://fake-host/index.html"));
        return new Response(html.body, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error", detail: err.message }, 500);
    }
  },
};

// ─── Route Handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/decide
 * Body: { sessionId, decision }
 * Generates Path A and Path B diary entries using Llama 3.3.
 */
async function handleDecide(request, env) {
  const { sessionId, decision } = await request.json();

  if (!sessionId || !decision) {
    return jsonResponse({ error: "sessionId and decision are required" }, 400);
  }

  // Load this user's past decisions for context
  const history = await loadHistory(env, sessionId);
  const historyContext = buildHistoryContext(history);

  // Build the prompt
  const prompt = buildDecisionPrompt(decision, historyContext);

  // Call Llama 3.3 via Workers AI
  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 1200,
    temperature: 0.85,
  });

  const rawText = aiResponse.response ?? "";

  // Parse the structured response from the model
  const parsed = parseDiaryResponse(rawText);

  // Persist to KV
  const decisionId = `decision_${Date.now()}`;
  const checkinDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days out

  const record = {
    decisionId,
    decision,
    timestamp: new Date().toISOString(),
    pathA_diary: parsed.pathA,
    pathB_diary: parsed.pathB,
    userChoice: null,
    commitment: null,
    checkinDate,
    actualOutcome: null,
    accuracyRating: null,
  };

  await saveDecision(env, sessionId, decisionId, record);

  return jsonResponse({
    decisionId,
    decision,
    pathA: parsed.pathA,
    pathB: parsed.pathB,
    checkinDate,
  });
}

/**
 * POST /api/checkin
 * Body: { sessionId, decisionId, actualOutcome, accuracyRating (1-5), userChoice }
 * Records the real-world outcome and generates a reflective AI response.
 */
async function handleCheckin(request, env) {
  const { sessionId, decisionId, actualOutcome, accuracyRating, userChoice } =
    await request.json();

  if (!sessionId || !decisionId) {
    return jsonResponse({ error: "sessionId and decisionId are required" }, 400);
  }

  // Load the existing record
  const record = await loadDecision(env, sessionId, decisionId);
  if (!record) {
    return jsonResponse({ error: "Decision not found" }, 404);
  }

  // Update the record with outcome data
  if (userChoice) record.userChoice = userChoice;
  if (actualOutcome) record.actualOutcome = actualOutcome;
  if (accuracyRating) record.accuracyRating = accuracyRating;

  await saveDecision(env, sessionId, decisionId, record);

  // Generate a reflective AI response
  const prompt = buildCheckinPrompt(record);

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 500,
    temperature: 0.75,
  });

  return jsonResponse({
    reflection: aiResponse.response ?? "",
    record,
  });
}

/**
 * GET /api/history?sessionId=xxx
 * Returns all past decisions for a session.
 */
async function handleHistory(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, 400);
  }

  const history = await loadHistory(env, sessionId);
  return jsonResponse({ decisions: history });
}

/**
 * POST /api/commitment
 * Body: { sessionId, decisionId, userChoice, commitment }
 * Saves the user's chosen path and 24-hour commitment.
 */
async function handleCommitment(request, env) {
  const { sessionId, decisionId, userChoice, commitment } = await request.json();

  if (!sessionId || !decisionId) {
    return jsonResponse({ error: "sessionId and decisionId are required" }, 400);
  }

  const record = await loadDecision(env, sessionId, decisionId);
  if (!record) {
    return jsonResponse({ error: "Decision not found" }, 404);
  }

  record.userChoice = userChoice ?? record.userChoice;
  record.commitment = commitment ?? record.commitment;

  await saveDecision(env, sessionId, decisionId, record);

  // Generate a motivational follow-up nudge
  const prompt = buildCommitmentPrompt(record);

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 300,
    temperature: 0.8,
  });

  return jsonResponse({
    nudge: aiResponse.response ?? "",
    checkinDate: record.checkinDate,
  });
}

/**
 * POST /api/schedule-checkin
 * Body: { sessionId, decisionId, decision, userChoice, commitment, checkinDate }
 * Launches a Cloudflare Workflow that sleeps until checkinDate, then marks
 * the decision as ready for check-in and generates an AI reminder.
 */
async function handleScheduleCheckin(request, env) {
  const body = await request.json();
  const { sessionId, decisionId, decision, userChoice, commitment, checkinDate } = body;

  if (!sessionId || !decisionId || !checkinDate) {
    return jsonResponse({ error: "sessionId, decisionId, and checkinDate are required" }, 400);
  }

  // Use a deterministic instance ID so re-scheduling the same decision
  // doesn't create duplicate workflows.
  const instanceId = `checkin-${sessionId}-${decisionId}`;

  try {
    const instance = await env.CHECKIN_WORKFLOW.create({
      id: instanceId,
      params: { sessionId, decisionId, decision, userChoice, commitment, checkinDate },
    });

    return jsonResponse({
      workflowInstanceId: instance.id,
      status: "scheduled",
      checkinDate,
    });
  } catch (err) {
    // If the workflow instance already exists, that's fine — it's already scheduled.
    if (err.message?.includes("already exists")) {
      return jsonResponse({
        workflowInstanceId: instanceId,
        status: "already_scheduled",
        checkinDate,
      });
    }
    throw err;
  }
}

/**
 * GET /api/workflow-status?instanceId=xxx
 * Returns the current status of a Workflow instance.
 */
async function handleWorkflowStatus(request, env) {
  const url = new URL(request.url);
  const instanceId = url.searchParams.get("instanceId");

  if (!instanceId) {
    return jsonResponse({ error: "instanceId is required" }, 400);
  }

  try {
    const instance = await env.CHECKIN_WORKFLOW.get(instanceId);
    const status = await instance.status();
    return jsonResponse({ instanceId, status });
  } catch (err) {
    return jsonResponse({ error: "Workflow instance not found", detail: err.message }, 404);
  }
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function saveDecision(env, sessionId, decisionId, record) {
  // Store individual decision
  await env.DECISIONS_KV.put(
    `${sessionId}:${decisionId}`,
    JSON.stringify(record),
    { expirationTtl: 60 * 60 * 24 * 365 } // 1 year TTL
  );

  // Update the session index (list of decisionIds)
  const indexKey = `index:${sessionId}`;
  const existing = await env.DECISIONS_KV.get(indexKey, "json") ?? [];
  if (!existing.includes(decisionId)) {
    existing.push(decisionId);
    await env.DECISIONS_KV.put(indexKey, JSON.stringify(existing), {
      expirationTtl: 60 * 60 * 24 * 365,
    });
  }
}

async function loadDecision(env, sessionId, decisionId) {
  return await env.DECISIONS_KV.get(`${sessionId}:${decisionId}`, "json");
}

async function loadHistory(env, sessionId) {
  const indexKey = `index:${sessionId}`;
  const ids = await env.DECISIONS_KV.get(indexKey, "json") ?? [];

  const records = await Promise.all(
    ids.map((id) => env.DECISIONS_KV.get(`${sessionId}:${id}`, "json"))
  );

  return records
    .filter(Boolean)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((r) => ({
      decisionId: r.decisionId,
      decision: r.decision,
      timestamp: r.timestamp,
      pathA_diary: r.pathA_diary ?? null,
      pathB_diary: r.pathB_diary ?? null,
      userChoice: r.userChoice ?? null,
      commitment: r.commitment ?? null,
      checkinDate: r.checkinDate ?? null,
      checkinReady: r.checkinReady ?? false,
      reminderText: r.reminderText ?? null,
      actualOutcome: r.actualOutcome ?? null,
      accuracyRating: r.accuracyRating ?? null,
    }));
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

function buildHistoryContext(history) {
  if (!history.length) return "";

  const lines = history.slice(0, 5).map((h) => {
    const chosen = h.userChoice ? ` (chose: ${h.userChoice})` : "";
    const outcome = h.actualOutcome ? ` | Outcome: "${h.actualOutcome}"` : "";
    const rating = h.accuracyRating ? ` | Accuracy: ${h.accuracyRating}/5` : "";
    return `- "${h.decision}"${chosen}${outcome}${rating}`;
  });

  return `\n\nUser's past decisions for context:\n${lines.join("\n")}`;
}

function buildDecisionPrompt(decision, historyContext) {
  return `The user is facing this decision: "${decision}"${historyContext}

Write two emotionally resonant future diary entries — one for each path. Follow this EXACT format:

PATH_A_START
[Write a vivid, personal diary entry dated roughly one year from now where the user DID take the action. Include specific sensory details, emotional highs and lows, unexpected consequences, and a moment of clarity. 3-4 paragraphs. First person.]
PATH_A_END

PATH_B_START
[Write a vivid, personal diary entry dated roughly one year from now where the user did NOT take the action. Include the quiet regrets, the unexpected upsides, the "what ifs", and a moment of honest reflection. 3-4 paragraphs. First person.]
PATH_B_END

Make both paths feel real and human — not propaganda for one choice. Both should have genuine trade-offs.`;
}

function buildCheckinPrompt(record) {
  return `The user previously faced this decision: "${record.decision}"

Path A diary (if they acted): "${record.pathA_diary?.slice(0, 300)}..."
Path B diary (if they didn't): "${record.pathB_diary?.slice(0, 300)}..."

They chose: ${record.userChoice ?? "not specified"}
What actually happened: "${record.actualOutcome}"
They rated prediction accuracy: ${record.accuracyRating}/5

Write a warm, insightful 2-paragraph reflection. Acknowledge what the AI got right or wrong. Find the deeper pattern. End with one forward-looking question that helps them grow.`;
}

function buildCommitmentPrompt(record) {
  return `The user decided: "${record.decision}"
They chose: ${record.userChoice}
Their 24-hour commitment: "${record.commitment}"

Write a brief (2-3 sentence) warm, encouraging message that:
1. Acknowledges their specific commitment
2. Reminds them WHY this step matters
3. Ends with a check-in reminder for ${new Date(record.checkinDate).toLocaleDateString("en-US", { month: "long", day: "numeric" })}

Keep it human and grounded — not cheesy.`;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseDiaryResponse(text) {
  const pathAMatch = text.match(/PATH_A_START\s*([\s\S]*?)\s*PATH_A_END/);
  const pathBMatch = text.match(/PATH_B_START\s*([\s\S]*?)\s*PATH_B_END/);

  return {
    pathA: pathAMatch ? pathAMatch[1].trim() : extractFallback(text, 0),
    pathB: pathBMatch ? pathBMatch[1].trim() : extractFallback(text, 1),
  };
}

function extractFallback(text, index) {
  // If markers are missing, split roughly in half
  const half = Math.floor(text.length / 2);
  return index === 0 ? text.slice(0, half).trim() : text.slice(half).trim();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Consequence Visualizer — an empathetic AI that helps people emotionally experience the future consequences of their decisions before making them.

Your core skill is writing vivid, emotionally honest future diary entries that feel like real human experiences — not motivational posters. You capture:
- The unexpected small moments (good and bad)
- The emotional texture of daily life after a choice
- Genuine trade-offs without propaganda
- The quiet voice of regret OR the quiet voice of relief

You are warm, perceptive, and non-judgmental. You never tell people what to choose. You help them feel both futures so they can choose with their whole self, not just their rational mind.

When writing diary entries: use specific dates, sensory details, real emotions, and honest complexity. Avoid clichés. Make it feel like a real person wrote it.`;
