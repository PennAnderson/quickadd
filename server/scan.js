/* =====================================================================
   Vision-based username extraction for the Quick Add scanner.
   Sends a single (already client-preprocessed) image to a Claude vision
   model and gets back structured JSON: [{username, confidence}].

   PRIVACY: the image lives only in memory for the duration of the call —
   it is never written to disk or persisted. Only the extracted usernames
   (people the user is choosing to add) are returned to the browser.

   The API key comes from ANTHROPIC_API_KEY (env). Model defaults to
   claude-opus-4-8 and can be overridden with SCAN_MODEL.
   ===================================================================== */
import Anthropic from '@anthropic-ai/sdk';

const SCAN_MODEL = process.env.SCAN_MODEL || 'claude-opus-4-8';
const RE_USERNAME = /^[a-z][a-z0-9._-]{2,14}$/; // Snapchat username shape

// lazily constructed so the app still boots without a key (scan disabled)
let client = null;
export function scanConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

// Structured-output schema: forces a clean array of {username, confidence}
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    usernames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string' },
          name: { type: 'string' },
          confidence: { type: 'number' },
          mutual: { type: 'number' },
          box: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
        },
        required: ['username', 'name', 'confidence', 'mutual', 'box'],
      },
    },
  },
  required: ['usernames'],
};

const PROMPT = `This image is a screenshot of the Snapchat "Quick Add" / "Add Friends" screen.

Extract the Snapchat USERNAME (the unique handle) for each suggested person.

For each suggested person return: the username, a confidence, and the mutual-friend count shown on their card.

Rules:
- "username" is the lowercase handle (letters, digits, period, underscore, hyphen) — usually shown beneath or beside the person's display name, sometimes after an "@". Strip any leading "@".
- "name" is the person's DISPLAY NAME shown on the card (e.g. "Sarah Mitchell"). Return it as-is. If no display name is visible, use an empty string "".
- The username is NOT the display name (e.g. "Sarah Mitchell") and NOT UI text ("Added by Search", "Quick Add", button labels). Never return those as usernames.
- If a card shows ONLY a display name and no visible username handle, OMIT that person entirely — never guess or invent a username.
- "mutual" is the number of mutual friends shown on that person's card (e.g. text like "12 mutual friends" → 12). If no mutual-friends count is visible for that person, use 0.
- "box" is the bounding box of that person's profile picture / avatar, as fractions of the image size: x and y are the top-left corner (0 = left/top, 1 = right/bottom), w and h are the width and height. Estimate it as tightly as you can around just the avatar. If you cannot locate the avatar, set all four to 0.
- "confidence" is 0 to 1, reflecting how clearly you can read the handle.
- Deduplicate by username.`;

/* Tolerant parse: structured outputs returns clean JSON, but also handle a
   fenced or bare array/object just in case the model formats differently. */
function parseUsernameList(text) {
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let v = tryParse(text);
  if (!v) {
    const obj = text.match(/\{[\s\S]*\}/);
    const arr = text.match(/\[[\s\S]*\]/);
    v = (obj && tryParse(obj[0])) || (arr && tryParse(arr[0])) || null;
  }
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Array.isArray(v.usernames) ? v.usernames : [];
}

export async function extractUsernames({ mediaType, data }) {
  const resp = await getClient().messages.create({
    model: SCAN_MODEL,
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  const text = resp.content.find(b => b.type === 'text')?.text || '';
  const raw = parseUsernameList(text);

  // server-side validation + dedupe (don't trust the model blindly)
  const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));
  const seen = new Set();
  const out = [];
  for (const u of raw) {
    const name = String(u?.username || '').replace(/^@/, '').toLowerCase().trim();
    if (!RE_USERNAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const b = u?.box || {};
    out.push({
      username: name,
      name: String(u?.name || '').trim().slice(0, 60),   // display name (ephemeral, client-only)
      confidence: clamp01(u?.confidence),
      mutual: Math.max(0, Math.floor(Number(u?.mutual) || 0)), // 0 = unknown; no cap
      box: { x: clamp01(b.x), y: clamp01(b.y), w: clamp01(b.w), h: clamp01(b.h) },
    });
  }
  return out;
}
