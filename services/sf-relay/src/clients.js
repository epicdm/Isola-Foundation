/** The outbound HTTP clients. Plain fetch, bounded by timeouts, never log message text or tokens. */

/**
 * rc9: the PL action adapter's deterministic action path (taps, STOP/START, Flow Done). The adapter re-verifies everything itself
 * (signed relay context + Chatwoot readback of the message, and of the offered choice for a tap); this client only carries them.
 * Never throws: an unreachable adapter is { code: "unreachable" } and the relay falls back to its ordinary path.
 */
export function adapterClient({ baseUrl, bearer, fetchImpl = fetch, timeoutMs = 20000 }) {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    async act({ context, action }) {
      try {
        const res = await fetchImpl(`${root}/v1/action`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ context, action }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { code: "unreachable", detail: `http_${res.status}` };
        const j = await res.json().catch(() => null);
        return j && typeof j.code === "string" ? j : { code: "unreachable", detail: "bad_json" };
      } catch (err) {
        return { code: "unreachable", detail: err?.name === "TimeoutError" ? "timeout" : "network" };
      }
    },
  };
}

/**
 * rc10g (owner 2026-10-11, "Yes, add read + typing"): WhatsApp read receipt + typing indicator for the customer's message.
 * Chatwoot 4.18 cannot send either (no read/typing call in its WhatsApp Cloud provider), so this is the ONE Meta call the
 * relay makes itself: POST /{phone_number_id}/messages {status:"read", message_id, typing_indicator:{type:"text"}}. It sends
 * no message; Chatwoot stays the only sender. Meta dismisses the indicator on our reply or after 25 s.
 * Cosmetic: never throws, never blocks the turn, never logs the token or the message id.
 */
export function waPresenceClient({ token, phoneNumberId, graphVersion = "v21.0", fetchImpl = fetch, timeoutMs = 4000 }) {
  if (typeof token !== "string" || token.length < 20) throw new Error("wa_presence_token_invalid");
  if (!/^[0-9]{5,20}$/.test(String(phoneNumberId ?? ""))) throw new Error("wa_presence_phone_number_id_invalid");
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  return {
    async markReadTyping(wamid) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: wamid, typing_indicator: { type: "text" } }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          return { ok: false, detail: `http_${res.status}`, metaCode: Number.isInteger(j?.error?.code) ? j.error.code : null };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err?.name === "TimeoutError" ? "timeout" : "network" };
      }
    },
  };
}

export function chatwootClient({ baseUrl, accountId, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1/accounts/${accountId}`;
  async function call(method, path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { "content-type": "application/json", api_access_token: token },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`chatwoot ${method} ${path.replace(/\/\d+/g, "/:id")} -> HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  return {
    // The live-ownership read is idempotent: one fresh attempt after a timeout / dropped connection (never after an HTTP
    // status, which is an answer). Measured 2026-10-03: two 8 s aborts in a row on a read that answers in ~1 s when probed.
    getConversation: async (id) => {
      try {
        return await call("GET", `/conversations/${id}`);
      } catch (err) {
        if (err instanceof Error && /^chatwoot /.test(err.message)) throw err;
        return call("GET", `/conversations/${id}`);
      }
    },
    getContact: async (id) => call("GET", `/contacts/${id}`),
    // rc10i: recent messages of ONE conversation (same tenant, same bot token), used only to carry context across an Uplink conversation rotation.
    listMessages: async (id) => call("GET", `/conversations/${id}/messages`),
    updateConversationCustomAttributes: (id, customAttributes) =>
      call("POST", `/conversations/${id}/custom_attributes`, {
        custom_attributes: customAttributes,
        merge: true,
      }),
    // rc10: an optional `items` list makes it a choices message (Chatwoot input_select -> WhatsApp reply buttons, or a list above 3).
    postMessage: (id, content, { private: isPrivate, items = null }) =>
      call("POST", `/conversations/${id}/messages`, Array.isArray(items) && items.length > 0 && isPrivate !== true
        ? { content, message_type: "outgoing", private: false, content_type: "input_select", content_attributes: { items } }
        : { content, message_type: "outgoing", private: isPrivate === true }),
    toggleStatus: (id, status) => call("POST", `/conversations/${id}/toggle_status`, { status }),
    assignOwner: (id, userId) => call("POST", `/conversations/${id}/assignments`, { assignee_id: userId }),
    assignTeam: (id, teamId) => call("POST", `/conversations/${id}/assignments`, { team_id: teamId }),
  };
}

/**
 * SeldonFrame website-chatbot agent. `turn` uses the PUBLIC chat endpoint (no credential). `escalation` reads the
 * conversation back through the authenticated API to learn whether the agent called `escalate_to_human`; the public
 * endpoint does not report that. Without a token it answers { known: false } and the relay logs that it is unknown.
 */
export function seldonClient({ baseUrl, slug, workspaceId = null, agentId = null, token = null, fetchImpl = fetch, timeoutMs = 60000 }) {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    async turn({ message, conversationId, sessionId, conversationCapability, channelMeta, relayContext }) {
      let res;
      try {
        const headers = { "content-type": "application/json" };
        if (typeof relayContext === "string" && relayContext.length > 0) {
          headers["x-isola-relay-context"] = relayContext;
        }
        res = await fetchImpl(`${root}/api/v1/public/agent/${encodeURIComponent(slug)}/turn`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message,
            conversation_id: conversationId ?? undefined,
            anonymous_session_id: sessionId,
            ...(conversationCapability ? { conversation_capability: conversationCapability } : {}),
            ...(channelMeta ? { channel_meta: channelMeta } : {}),
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { ok: false, reason: err?.name === "TimeoutError" ? "timeout" : "unreachable", conversationId: null };
      }
      let j = {};
      try { j = await res.json(); } catch { /* not JSON */ }
      const conversationId2 = typeof j.conversation_id === "string" ? j.conversation_id : null;
      const conversationCapability2 = typeof j.conversation_capability === "string" ? j.conversation_capability : null;
      const capabilityField = conversationCapability2 ? { conversationCapability: conversationCapability2 } : {};
      // rc10c: carry Uplink's machine error code (e.g. PUBLIC_CHAT_CONVERSATION_LIMIT) so the relay can act on it; never the message text.
      if (!res.ok) return { ok: false, reason: `http_${res.status}`, error: typeof j.error === "string" ? j.error.slice(0, 64) : null, conversationId: conversationId2, ...capabilityField };
      if (j.degraded === true) return { ok: false, reason: typeof j.reason === "string" ? j.reason : "degraded", conversationId: conversationId2, ...capabilityField };
      if (j.validators_critical_failed === true) return { ok: false, reason: "validator_failed", conversationId: conversationId2, ...capabilityField };
      const text = typeof j.message === "string" ? j.message.trim() : "";
      if (text.length === 0) return { ok: false, reason: "empty_reply", conversationId: conversationId2, ...capabilityField };
      return { ok: true, text, conversationId: conversationId2, ...capabilityField };
    },

    async escalation(sfConversationId) {
      if (!token || !workspaceId || !sfConversationId) return { known: false };
      const res = await fetchImpl(`${root}/api/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-org-id": workspaceId },
        body: JSON.stringify({ op: "get_conversation", conversation_id: sfConversationId }),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { known: false };
      const j = await res.json();
      const turns = j?.turns ?? j?.data?.turns;
      if (!Array.isArray(turns)) return { known: false };
      const lastAssistant = [...turns].reverse().find((t) => t?.role === "assistant");
      if (!lastAssistant) return { known: true, escalated: false };
      // Either tool promises the visitor a person: escalate_to_human, or take_message (which also writes the CRM contact).
      const calls = Array.isArray(lastAssistant.toolCalls) ? lastAssistant.toolCalls : [];
      const call = calls.find((c) => c?.name === "escalate_to_human") ?? calls.find((c) => c?.name === "take_message");
      if (!call) return { known: true, escalated: false };
      const i = call.input ?? {};
      const raw = call.name === "take_message"
        ? `callback requested: ${i.caller_name ?? "?"} ${i.caller_phone ?? ""} - ${i.message ?? ""}`
        : i.reason;
      const reason = typeof raw === "string" ? raw.slice(0, 300) : null;
      return { known: true, escalated: true, reason };
    },

    /** Read the authenticated, persisted current turn before trusting any action result for customer delivery. */
    async inspectTurn({ conversationId, sessionId, userMessage, chatwootConversationId, accountId, inboxId }) {
      if (!token || !workspaceId || !agentId || !conversationId || !sessionId || typeof userMessage !== "string"
        || !Number.isSafeInteger(chatwootConversationId) || !Number.isSafeInteger(accountId) || !Number.isSafeInteger(inboxId)) return { known: false, reason: "readback_unavailable" };
      let res;
      try {
        res = await fetchImpl(`${root}/api/v1/agents`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-org-id": workspaceId },
          body: JSON.stringify({ op: "get_conversation", conversation_id: conversationId }),
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { known: false, reason: "readback_failed" };
        const j = await res.json();
        const conv = j?.conversation ?? j?.data?.conversation;
        const turns = j?.turns ?? j?.data?.turns;
        if (!conv || conv.id !== conversationId || conv.orgId !== workspaceId || conv.agentId !== agentId
          || conv.anonymousSessionId !== sessionId
          || conv.channelMeta?.source !== "chatwoot"
          || conv.channelMeta?.account_id !== accountId
          || conv.channelMeta?.inbox_id !== inboxId
          || conv.channelMeta?.conversation_id !== chatwootConversationId) {
          return { known: false, reason: "readback_scope_mismatch" };
        }
        if (!Array.isArray(turns) || turns.length < 2) return { known: false, reason: "current_turn_missing" };
        const assistant = turns.at(-1);
        const user = turns.at(-2);
        if (assistant?.role !== "assistant" || user?.role !== "user" || user.content !== userMessage) {
          return { known: false, reason: "current_turn_mismatch" };
        }
        const toolCalls = Array.isArray(assistant.toolCalls) ? assistant.toolCalls : [];
        const toolResults = Array.isArray(assistant.toolResults) ? assistant.toolResults : [];
        const calls = toolCalls;
        const call = calls.find((c) => c?.name === "escalate_to_human") ?? calls.find((c) => c?.name === "take_message");
        if (!call) return { known: true, currentTurnVerified: true, escalated: false, toolCalls, toolResults };
        const input = call.input ?? {};
        const raw = call.name === "take_message"
          ? `callback requested: ${input.caller_name ?? "?"} ${input.caller_phone ?? ""} - ${input.message ?? ""}`
          : input.reason;
        return {
          known: true,
          currentTurnVerified: true,
          escalated: true,
          reason: typeof raw === "string" ? raw.slice(0, 300) : null,
          toolCalls,
          toolResults,
        };
      } catch {
        return { known: false, reason: "readback_failed" };
      }
    },
  };
}
