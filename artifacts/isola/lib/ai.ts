/**
 * AI client — Anthropic Claude only.
 *
 * Intelligence tiers (per-agent setting, tenant chooses):
 *   standard → claude-haiku-4-5       fast, low cost
 *   advanced → claude-sonnet-4-5      balanced quality/cost
 *   expert   → claude-opus-4-5        highest capability
 *
 * Requires: ANTHROPIC_API_KEY in Replit Secrets.
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Model tiers ───────────────────────────────────────────────────────────────

export const TIER_MODELS: Record<string, string> = {
  standard: 'claude-haiku-4-5',
  advanced: 'claude-sonnet-4-5',
  expert:   'claude-opus-4-5',
};

/** USD cost per 1 K tokens (blended input + output estimate). */
export const TIER_COST_PER_1K: Record<string, number> = {
  'claude-haiku-4-5':  0.00080,  // ~$0.80/M tokens
  'claude-sonnet-4-5': 0.00300,  // ~$3/M tokens
  'claude-opus-4-5':   0.01500,  // ~$15/M tokens
};

// ── Client (lazy singleton) ───────────────────────────────────────────────────

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set — add it to Replit Secrets');
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// ── Unified chat completion ───────────────────────────────────────────────────

export async function chatComplete(params: {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: params.messages,
  });

  const block = response.content.find((b) => b.type === 'text');
  return {
    text: block?.type === 'text' ? block.text.trim() : '',
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
