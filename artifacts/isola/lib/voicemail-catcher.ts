/**
 * lib/voicemail-catcher.ts — per-tenant "AI missed-call catcher" core intelligence
 *
 * PORT of Isola Lite's app/lib/lite-catcher.ts (deepseek /opt/bff-v2,
 * PROVEN in production). Converts an Asterisk voicemail recording into a
 * structured summary via:
 *   1. parseVoicemailMeta()  — parse the .txt sidecar from Asterisk voicemail
 *   2. transcribeVoicemail() — shell out to faster-whisper via transcribe_otp.py
 *   3. summarizeVoicemail()  — call Foundation's lib/ai.ts (Claude client)
 *
 * HARD RAIL (unchanged from source): if transcript is empty/garbled/too
 * short or the model is unsure, confident=false. NEVER fabricate intent not
 * in the transcript.
 *
 * KNOWN GAP: transcribe_otp.py (faster-whisper wrapper) is a Lite-side
 * script that does not yet exist in this repo. TRANSCRIBE_SCRIPT below
 * points at the same relative path convention as source
 * (scripts/transcribe_otp.py under the app root) so this ports cleanly the
 * moment that script is copied over; until then transcribeVoicemail()
 * degrades to '' (see try/catch — matches source behavior on missing
 * script) and summarizeVoicemail() falls through its own "too short/empty"
 * hard rail, so the poller still runs safely, just with unconfident catches.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chatComplete, TIER_MODELS } from '@/lib/ai';

// Path to the shared transcription script. Mirrors source's convention
// (co-located under the app's scripts/ dir) rather than the bff-v2
// absolute path, since Foundation is not deployed at /opt/bff-v2.
const TRANSCRIBE_SCRIPT = path.join(process.cwd(), 'scripts', 'transcribe_otp.py');

// Minimum transcript word count to consider it intelligible
const MIN_TRANSCRIPT_WORDS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

export interface VoicemailMeta {
  callerId: string; // raw callerid string from sidecar (may include name)
  calledExten: string; // exten= field (the mailbox / DID that was called)
  origtime: number; // Unix epoch seconds
  durationSec: number; // call duration in seconds
}

export interface VoicemailSummary {
  summary: string;
  intent: string;
  urgency: 'low' | 'normal' | 'urgent';
  callbackNumber: string | null;
  confident: boolean;
}

// ── 1. parseVoicemailMeta ────────────────────────────────────────────────────

/**
 * Parse an Asterisk voicemail .txt sidecar file.
 * Format example (from /var/spool/asterisk/voicemail/billing/<mailbox>/INBOX/msgNNNN.txt):
 *
 *   ;
 *   ; Message Information file
 *   ;
 *   [message]
 *   origmailbox=1001
 *   context=default
 *   macrocontext=
 *   exten=17678189796
 *   rdnis=unknown
 *   priority=2
 *   callerchan=PJSIP/...
 *   callerid="Maria" <+17675550123>
 *   origtime=1718642400
 *   duration=28
 *   ...
 *
 * Keys are lowercased for resilience. Unchanged from source.
 */
export function parseVoicemailMeta(txt: string): VoicemailMeta {
  const kv: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([a-zA-Z_]+)\s*=\s*(.*)$/);
    if (m) {
      kv[m[1].toLowerCase().trim()] = m[2].trim();
    }
  }

  // callerid may be `"Name" <+E164>` or just a bare number
  const rawCid = kv['callerid'] ?? '';
  const cidMatch = rawCid.match(/<([+\d]+)>/) || rawCid.match(/([\d+]+)/);
  const callerId = cidMatch ? cidMatch[1] : rawCid;

  const calledExten = kv['exten'] ?? '';
  const origtime = parseInt(kv['origtime'] ?? '0', 10) || 0;
  const durationSec = parseInt(kv['duration'] ?? '0', 10) || 0;

  return { callerId, calledExten, origtime, durationSec };
}

// ── 2. transcribeVoicemail ───────────────────────────────────────────────────

/**
 * Transcribe a WAV file by shelling out to transcribe_otp.py (faster-whisper
 * tiny). Returns the transcript string, or '' on failure. See KNOWN GAP note
 * at the top of this file — the script is not yet present in Foundation.
 */
export async function transcribeVoicemail(wavPath: string): Promise<string> {
  if (!fs.existsSync(wavPath)) {
    console.error(`[voicemail-catcher] transcribeVoicemail: file not found: ${wavPath}`);
    return '';
  }

  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    console.error(`[voicemail-catcher] transcribeVoicemail: script not found at ${TRANSCRIBE_SCRIPT} — see KNOWN GAP in this file's header`);
    return '';
  }

  try {
    const raw = execSync(`python3 "${TRANSCRIBE_SCRIPT}" "${wavPath}"`, {
      timeout: 90_000, // whisper can be slow on first load
      encoding: 'utf8',
    }).trim();

    const parsed = JSON.parse(raw);
    const transcript = (parsed?.transcript ?? '').trim();
    console.log(`[voicemail-catcher] transcript="${transcript.slice(0, 120)}"`);
    return transcript;
  } catch (err: any) {
    console.error('[voicemail-catcher] transcribeVoicemail error:', err.message);
    return '';
  }
}

// ── 3. summarizeVoicemail ────────────────────────────────────────────────────

/**
 * Summarize a voicemail transcript using Foundation's lib/ai.ts
 * (chatComplete → Anthropic Claude). Same prompts, same hard rails, same
 * JSON contract as the Lite source — the only change is the client call
 * (chatComplete vs. bff-v2's callAI/ai-provider.ts, which has no
 * Foundation equivalent).
 *
 * HARD RAILS (unchanged from source):
 * - If transcript is empty/too short/garbled → confident=false, summary says "couldn't make out"
 * - LLM must not invent intent beyond what is literally in the transcript
 * - LLM returns JSON; if it doesn't parse cleanly → confident=false fallback
 * - Urgency defaults to 'normal'; only 'urgent' when transcript explicitly says so
 */
export async function summarizeVoicemail(opts: {
  transcript: string;
  callerId: string;
  durationSec: number;
}): Promise<VoicemailSummary> {
  const { transcript, callerId, durationSec } = opts;

  // HARD RAIL: short/empty transcript — return without calling the model
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (!transcript.trim() || wordCount < MIN_TRANSCRIPT_WORDS) {
    return {
      summary: `Caller left a message I couldn't make out — callback ${callerId || 'unknown'}`,
      intent: 'unclear',
      urgency: 'normal',
      callbackNumber: callerId || null,
      confident: false,
    };
  }

  const system = `You are an AI receptionist summarizer. A business has received a voicemail.
Your job: extract ONLY information explicitly stated in the transcript. Never invent or infer beyond what is said.

Respond with ONLY valid JSON — no markdown, no prose, no code fences. Format:
{
  "summary": "<1-2 sentence plain summary of what the caller said>",
  "intent": "<single phrase: e.g. 'plumbing quote', 'appointment request', 'complaint', 'unclear'>",
  "urgency": "<one of: low | normal | urgent — urgent ONLY if caller explicitly says emergency/urgent/today/ASAP>",
  "callbackNumber": "<phone number the caller left, or null if not stated>",
  "confident": <true if you understood the message clearly, false if garbled or ambiguous>
}

RULES:
- callbackNumber: extract ONLY if the caller explicitly stated a callback number in the transcript. If not stated, null.
- urgency: default to "normal". Use "urgent" only for explicit urgency words (emergency, urgent, ASAP, today, right away, burst pipe, flooding, etc.).
- summary: always provide the best available description of what the caller said, even when uncertain; describe the actual content, do NOT use generic "unclear" phrases.
- confident: false if the transcript looks like nonsense, repetition, or too short to meaningfully interpret`;

  const userMsg = `Voicemail details:
- Caller ID: ${callerId || 'unknown'}
- Duration: ${durationSec}s
- Transcript: "${transcript}"`;

  try {
    const result = await chatComplete({
      model: TIER_MODELS.standard, // low-cost tier — factual extraction, not conversation
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 400,
    });

    const raw = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[voicemail-catcher] LLM returned non-JSON, falling back to uncertain:', raw.slice(0, 200));
      return {
        summary: transcript.length > 20 ? transcript.slice(0, 200) : `Caller left a message I couldn't make out — callback ${callerId || 'unknown'}`,
        intent: 'unclear',
        urgency: 'normal',
        callbackNumber: callerId || null,
        confident: false,
      };
    }

    const urgencyRaw = (parsed.urgency ?? 'normal').toLowerCase();
    const urgency: 'low' | 'normal' | 'urgent' =
      urgencyRaw === 'urgent' ? 'urgent' : urgencyRaw === 'low' ? 'low' : 'normal';

    const confident = typeof parsed.confident === 'boolean' ? parsed.confident : true;
    const summary = (parsed.summary ?? '').trim() || transcript.slice(0, 200);
    const intent = (parsed.intent ?? 'unclear').trim();
    const callbackNumber = parsed.callbackNumber ?? null;

    return { summary, intent, urgency, callbackNumber, confident };
  } catch (err: any) {
    console.error('[voicemail-catcher] summarizeVoicemail LLM error:', err.message);
    return {
      summary: `Caller left a message I couldn't make out — callback ${callerId || 'unknown'}`,
      intent: 'unclear',
      urgency: 'normal',
      callbackNumber: callerId || null,
      confident: false,
    };
  }
}
