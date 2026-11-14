// Household assistant: answers questions about the budget data with Claude.
// Runs on Vercel as a server function, so the Anthropic API key never reaches the browser.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  the key from console.anthropic.com
//   ALLOWED_EMAILS     comma-separated Google accounts allowed to ask, e.g. "you@gmail.com,partner@gmail.com"
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const config = { maxDuration: 120 };

const FIREBASE_PROJECT_ID = "finances-ed83f";
// Public keys Firebase signs its sign-in tokens with.
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

const MAX_SNAPSHOT_CHARS = 400_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_TURNS = 40;

const SYSTEM_PROMPT = `You are the household finance assistant inside "Jdeeds' Household", a budgeting app used by a couple (the members are named in the data). They enter their income and spending by hand and use the app for planning and overview. Answer their questions using the household data that follows.

How the app's data works:
- Months are calendar months. Everything counts in the month it actually arrives or is paid.
- Each item has, per month, a plan ("budget") and what really happened ("actual"). For income, actual means received; for bills and one-time payments, actual means paid; for variable items (groceries, household, leisure…), actual is what was spent, and the group has a monthly target.
- The app's expected numbers follow these rules: income = received, otherwise planned; fixed costs and one-time payments = paid, otherwise planned; variable groups = their monthly target, or more if already exceeded. Finished months count only what really happened.
- "computed" holds the app's own numbers per month (start balance, expected and actual in/out, end balance). Prefer these over recomputing; if you do compute something yourself, show the arithmetic briefly.
- "tx" are individual receipts and bank lines; "log" is the history of edits with timestamps (when an amount was changed and by whom).
- "today" is the current date. Entries dated after today are still plans.

How to answer:
- Reply in the language the question is written in (they write Arabic, English or German).
- Be direct and short: lead with the answer and the key number, then a few lines of explanation. Use euros formatted like 1,234.56 €.
- Only use numbers that are in the data. If something needed to answer is missing, say exactly what is missing instead of guessing.
- When the numbers look inconsistent (for example a plan that differs from what usually arrives, an item ticked before its date, a month that doesn't add up), point it out plainly and say what to change in the app.
- You can't change the data yourself; tell them which item, month and value to edit.`;

const anthropic = new Anthropic();

const fail = (res, status, error) => res.status(status).json({ error });

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  if (!process.env.ANTHROPIC_API_KEY) return fail(res, 500, "not_configured");

  // Only signed-in household members may spend API credit.
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!match) return fail(res, 401, "not_signed_in");
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(match[1], FIREBASE_KEYS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    }));
  } catch {
    return fail(res, 401, "not_signed_in");
  }
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(claims.email || "").toLowerCase();
  if (!claims.email_verified || !allowed.includes(email)) return fail(res, 403, "not_allowed");

  // Validate the request: the data snapshot and the conversation so far.
  const { snapshot, messages } = req.body || {};
  if (typeof snapshot !== "string" || snapshot.length > MAX_SNAPSHOT_CHARS) return fail(res, 400, "bad_snapshot");
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_TURNS) return fail(res, 400, "bad_messages");
  const valid = messages.every((m, i) => {
    if (m?.role === "user") return typeof m.content === "string" && m.content.trim() && m.content.length <= MAX_QUESTION_CHARS && i % 2 === 0;
    if (m?.role === "assistant") return Array.isArray(m.content) && i % 2 === 1;
    return false;
  });
  if (!valid || messages[messages.length - 1].role !== "user") return fail(res, 400, "bad_messages");

  try {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      output_config: { effort: "medium" },
      // If the model declines, the API retries on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        // The data changes rarely between questions, so it is cached for follow-ups.
        { type: "text", text: `Household data (JSON):\n${snapshot}`, cache_control: { type: "ephemeral" } },
      ],
      messages,
    });

    if (response.stop_reason === "refusal") return fail(res, 422, "refused");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return res.status(200).json({
      text,
      // Sent back unchanged with the next question so the conversation continues.
      content: response.content,
      truncated: response.stop_reason === "max_tokens",
      usage: response.usage,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return fail(res, 500, "bad_api_key");
    if (error instanceof Anthropic.RateLimitError) return fail(res, 429, "rate_limited");
    if (error instanceof Anthropic.BadRequestError) {
      console.error("Bad request:", error.message);
      return fail(res, 400, "api_bad_request");
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`API error ${error.status}:`, error.message);
      return fail(res, 502, "api_error");
    }
    console.error(error);
    return fail(res, 500, "server_error");
  }
}
