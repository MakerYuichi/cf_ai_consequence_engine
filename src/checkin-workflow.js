/**
 * CheckinWorkflow — Cloudflare Workflow
 *
 * Triggered when a user saves a commitment to a decision.
 * Sleeps until the scheduled check-in date, then:
 *   1. Marks the decision as "checkin_ready" in KV
 *   2. Generates a gentle AI reminder nudge and stores it
 *
 * Params passed via workflow.create():
 *   { sessionId, decisionId, decision, userChoice, commitment, checkinDate }
 */

import { WorkflowEntrypoint } from "cloudflare:workers";

export class CheckinWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { sessionId, decisionId, decision, userChoice, commitment, checkinDate } =
      event.payload;

    // ── Step 1: Wait until the check-in date ─────────────────────────────────
    const msUntilCheckin = new Date(checkinDate).getTime() - Date.now();

    if (msUntilCheckin > 0) {
      await step.sleep("wait-for-checkin-date", msUntilCheckin);
    }

    // ── Step 2: Generate an AI reminder nudge ─────────────────────────────────
    const reminderText = await step.do("generate-reminder", async () => {
      const checkinFormatted = new Date(checkinDate).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });

      const aiResponse = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        {
          messages: [
            {
              role: "system",
              content:
                "You are the Consequence Visualizer — a warm, grounded AI that helps people reflect on their decisions. Keep responses brief and human.",
            },
            {
              role: "user",
              content: `A week ago, someone faced this decision: "${decision}"
They chose: ${userChoice ?? "a path"}
Their 24-hour commitment was: "${commitment}"

Today (${checkinFormatted}) is their scheduled check-in day. Write a warm 2-sentence reminder that:
1. References their specific decision and commitment
2. Invites them to come back and record what actually happened

Keep it personal and grounded — not generic.`,
            },
          ],
          max_tokens: 200,
          temperature: 0.75,
        }
      );

      return aiResponse.response ?? "Time to check in on your decision. How did it go?";
    });

    // ── Step 3: Write the reminder back to KV ─────────────────────────────────
    await step.do("mark-checkin-ready", async () => {
      const key = `${sessionId}:${decisionId}`;
      const record = await this.env.DECISIONS_KV.get(key, "json");

      if (record) {
        record.checkinReady = true;
        record.reminderText = reminderText;
        await this.env.DECISIONS_KV.put(key, JSON.stringify(record), {
          expirationTtl: 60 * 60 * 24 * 365,
        });
      }
    });

    return { status: "checkin_ready", decisionId, reminderText };
  }
}
