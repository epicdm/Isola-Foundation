/**
 * lib/consumer-agent.ts — the P4 in-app companion agent for the consumer
 * PWA. A concierge chat scoped to exactly one signed-in ConsumerAccount.
 *
 * Reuses lib/ai.ts's Anthropic client (getAnthropicClient) as-is — this
 * module does NOT modify lib/ai.ts, lib/brain-provider.ts, lib/agent.ts, or
 * lib/agent-tools.ts. Those remain the tenant/WhatsApp-facing runtime;
 * this is a separate, consumer-facing runtime with its own tool catalog
 * (lib/consumer-agent-tools.ts) and its own trust boundary.
 *
 * Trust boundary (mirrors lib/agent-tools.ts's tenant-scope pattern): the
 * ConsumerAccount row is resolved ONCE from the session by the caller
 * (the chat route) and passed in here. The model can request a tool by
 * name + args, but every tool implementation ignores any account-like
 * field the model might hallucinate into its args — the account is always
 * the one closure variable, never re-derived from model output.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, TIER_MODELS } from './ai';
import {
  toolGetBalance,
  toolGetLineStatus,
  toolGetRecentCalls,
  toolInitiateTopup,
  toolSetCallForwarding,
  ConsumerToolError,
} from './consumer-agent-tools';
import type { ConsumerAccount } from '@prisma/client';

const MODEL = TIER_MODELS.standard; // claude-haiku-4-5 — concierge Q&A doesn't need a bigger model
const MAX_TOOL_ITERATIONS = 4;
const MAX_TOKENS = 1024;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_balance',
    description: "Get the signed-in consumer's current EMA wallet balance.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_line_status',
    description:
      "Get the signed-in consumer's phone line status: their DID number, provisioning state, and whether calls are currently forwarded to a cell number.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_calls',
    description: "Get the signed-in consumer's most recent call history.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent calls to fetch, default 5, max 20' } },
      required: [],
    },
  },
  {
    name: 'initiate_topup',
    description:
      'Propose a wallet top-up amount for the consumer. This does NOT charge any card — it only surfaces a "top up" action in the chat UI that takes the consumer to the top-up screen with the amount pre-filled, where they enter their own card details.',
    input_schema: {
      type: 'object',
      properties: { amount: { type: 'number', description: 'Suggested top-up amount in EC$, between 10 and 500' } },
      required: ['amount'],
    },
  },
  {
    name: 'set_call_forwarding',
    description:
      "Turn call forwarding to a cell number on or off for the signed-in consumer's line. Only call this when the consumer has clearly asked to change forwarding, and always confirm the cell number in your reply.",
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to forward to cell, false to ring the SIP extension' },
        cell_number: { type: 'string', description: 'Cell number to forward to, required when enabling' },
      },
      required: ['enabled'],
    },
  },
];

const SYSTEM_PROMPT = `You are the EMA Concierge — a friendly, concise in-app assistant inside the EMA consumer app (a phone line + softphone + wallet service, part of Isola/EPIC Communications, based in Dominica).

You help the signed-in consumer with:
- Checking their wallet balance (use get_balance — never guess a number).
- Topping up their balance (use initiate_topup to propose an amount; you never see or ask for card details — the app handles that separately).
- Setting up their softphone (Acrobits): tell them to open the "Softphone" tab, where they can scan a QR code or tap "Open in Acrobits" to auto-configure the app with their SIP credentials. If they don't have Acrobits yet, tell them it's on the App Store / Google Play.
- Call forwarding to a cell number (use get_line_status to check current state, set_call_forwarding to change it — only after they've clearly said what they want).
- Voicemail: be honest that voicemail isn't available on EMA yet — don't imply it exists or can be turned on.
- Their own DID number and line status (use get_line_status).
- Their recent calls (use get_recent_calls).
- General questions like "how do I call Dominica" — explain that once their line is set up in Acrobits, dialing works like any normal call (they can dial the local Dominica number or the full +1-767 number), and that calls are billed from their EMA wallet balance, so they should keep it topped up. Do not invent specific per-minute rates you don't know.

Rules:
- NEVER answer a balance, line-status, or call-history question from memory or by guessing — always call the matching tool first.
- NEVER fabricate account details (DID numbers, balances, call records) — if a tool fails or returns nothing, say so honestly.
- You only ever act on the ONE signed-in consumer's own account. You have no ability to look up or affect any other account, and you should say so if asked.
- Keep replies short and conversational — this is a mobile chat bubble, not an essay.
- If something is outside what you can do (e.g. billing disputes, refunds, porting a number), say so plainly and suggest they contact support — don't pretend to handle it.`;

export interface ConsumerChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConsumerChatAction {
  type: 'navigate_topup';
  amount: number;
}

export interface ConsumerChatResult {
  reply: string;
  actions: ConsumerChatAction[];
  toolCalls: { name: string; ok: boolean }[];
}

/**
 * Run one turn of the consumer concierge chat. `account` MUST already be
 * the trusted, session-resolved ConsumerAccount — this function never
 * fetches or re-derives it.
 */
export async function runConsumerAgentTurn(
  account: ConsumerAccount,
  history: ConsumerChatMessage[],
  userMessage: string,
): Promise<ConsumerChatResult> {
  const client = getAnthropicClient();

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
    { role: 'user', content: userMessage },
  ];

  const actions: ConsumerChatAction[] = [];
  const toolCalls: { name: string; ok: boolean }[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      const reply = textBlocks.map((b) => b.text).join('\n').trim();
      return { reply: reply || "Sorry, I didn't quite catch that — could you rephrase?", actions, toolCalls };
    }

    // Assistant's tool-use turn must be appended before the tool_result turn.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeConsumerTool(account, block.name, block.input);
      toolCalls.push({ name: block.name, ok: !result.isError });
      if (result.clientAction) actions.push(result.clientAction);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.output),
        is_error: result.isError,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: "I ran into trouble finishing that — could you try asking again, maybe more simply?",
    actions,
    toolCalls,
  };
}

// ── Tool dispatch — the only place model tool-call names turn into code ────

async function executeConsumerTool(
  account: ConsumerAccount,
  name: string,
  input: unknown,
): Promise<{ output: unknown; isError: boolean; clientAction?: ConsumerChatAction }> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'get_balance':
        return { output: await toolGetBalance(account), isError: false };
      case 'get_line_status':
        return { output: await toolGetLineStatus(account), isError: false };
      case 'get_recent_calls':
        return { output: await toolGetRecentCalls(account, Number(args.limit) || 5), isError: false };
      case 'initiate_topup': {
        const result = await toolInitiateTopup(account, Number(args.amount));
        return {
          output: result,
          isError: false,
          clientAction: { type: 'navigate_topup', amount: result.amount },
        };
      }
      case 'set_call_forwarding': {
        const result = await toolSetCallForwarding(
          account,
          !!args.enabled,
          typeof args.cell_number === 'string' ? args.cell_number : undefined,
        );
        return { output: result, isError: false };
      }
      default:
        return { output: { error: `unknown tool "${name}"` }, isError: true };
    }
  } catch (e) {
    const message = e instanceof ConsumerToolError ? e.message : e instanceof Error ? e.message : 'tool failed';
    console.error(`[consumer-agent] tool "${name}" failed:`, message);
    return { output: { error: message }, isError: true };
  }
}
