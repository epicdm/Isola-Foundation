/* Isola Front-of-House — Frontend Service Adapter (mock layer)
 * One adapter for ALL backend interactions. The UI depends only on these typed
 * contracts, never on backend implementation details. Switch mock -> real via
 * IsolaServices.configure({ mode:'real', baseUrl, token }) — no redesign needed.
 *
 * Contracts (request -> response) are documented inline. Every mock covers the
 * full state matrix: success | pending | assisted | validation | duplicate |
 * unavailable | payment_pending | payment_failed | provisioning_failed |
 * partial | retry | resume | human_takeover | rollback.
 */
(function (root) {
  'use strict';

  var config = { mode: 'mock', baseUrl: '', token: null, latency: 220, seed: {} };

  // ---- Approved catalogue (mirrors Port / content register) ----
  var CATALOG = {
    services: {
      business_line:  { name: 'Business Line', category: 'Communications', readiness: 'Assisted',    price: null,   priceLabel: 'Contact EPIC' },
      hosted_pbx:     { name: 'Hosted Business PBX', category: 'Communications', readiness: 'Conditional', price: null, priceLabel: 'Contact EPIC' },
      connect_pbx:    { name: 'Connect Existing PBX', category: 'Communications', readiness: 'Conditional', price: null, priceLabel: 'Contact EPIC' },
      personal_line:  { name: 'Personal Line', category: 'Communications', readiness: 'Conditional', price: 0.27, priceLabel: 'EC$0.27/min (≈ US$0.10)' }
    },
    assistants: {
      business_receptionist: { name: 'WhatsApp Business Receptionist (standalone)', readiness: 'Conditional', setup: 250, monthly: 149 },
      epic_assistant:        { name: 'EPIC Assistant', readiness: 'Conditional', note: 'Support benefit where verified' },
      sales_assistant:       { name: 'Sales Assistant', readiness: 'Conditional', priceLabel: 'Contact EPIC' },
      booking_assistant:     { name: 'Booking Assistant', readiness: 'Planned', priceLabel: 'Contact EPIC' },
      support_assistant:     { name: 'Support Assistant', readiness: 'Conditional', priceLabel: 'Contact EPIC' },
      account_assistant:     { name: 'Account Assistant', readiness: 'Planned', priceLabel: 'Contact EPIC' }
    },
    solutions: {
      smart_front_desk: { name: 'Smart Business Line / Smart Front Desk', readiness: 'Conditional',
        setup: 750, schedule: ['EC$375 before work', 'EC$375 at acceptance'], firstMonth: 249, monthly: 249, note: 'Voice balance separate',
        // Founding promo (dec-sbl-founding-price-value-and-promo-2026-07-22): half off setup
        // + the first 3 months, capped at the first 3 founding customers.
        promo: { label: 'Founding promo — first 3 customers', setup: 375, schedule: ['EC$187.50 before work', 'EC$187.50 at acceptance'], monthly: 124.5, monthlyMonths: 3, thenMonthly: 249, note: 'EC$124.50/mo for months 1-3, then EC$249/mo' } },
      pbx_ai_upgrade:   { name: 'Existing EPIC PBX AI Upgrade', readiness: 'Assisted', setup: 250, monthly: 99, note: 'Existing voice charges separate' },
      smart_office:     { name: 'Smart Office Phone System', readiness: 'Conditional', priceLabel: 'Contact EPIC' },
      whatsapp_sales_desk: { name: 'WhatsApp Sales Desk', readiness: 'Conditional', priceLabel: 'Contact EPIC' },
      support_desk:     { name: 'Customer Support Desk', readiness: 'Conditional', priceLabel: 'Contact EPIC' },
      personal_line_plus: { name: 'Personal Line+', readiness: 'Conditional', priceLabel: 'Contact EPIC' }
    }
  };

  // ---- helpers ----
  var _id = 0;
  function cid(prefix) { _id += 1; return (prefix || 'cor') + '_' + Date.now().toString(36) + '_' + _id; }
  function delay(ms) { var t = (ms == null ? config.latency : ms); if (!t) return Promise.resolve(); return new Promise(function (r) { setTimeout(r, t); }); }
  var _seen = {};                 // duplicate detection by idempotency key
  var _store = { leads: {}, customers: {}, journeys: {} };

  function ok(data, meta) { return Object.assign({ status: 'success', ok: true, correlationId: cid('cor') }, meta || {}, { data: data }); }
  function pending(data, meta) { return Object.assign({ status: 'pending', ok: true, correlationId: cid('cor') }, meta || {}, { data: data }); }
  function assisted(data, meta) { return Object.assign({ status: 'assisted', ok: true, human: true, correlationId: cid('cor') }, meta || {}, { data: data }); }
  function fail(code, message, meta) { return Object.assign({ status: 'error', ok: false, code: code, message: message, correlationId: cid('cor'), recovery: (meta && meta.recovery) || 'retry' }, meta || {}); }

  // Scenario override: tests pass { _scenario:'payment_failed' } to force a branch.
  function forced(req) { return req && req._scenario; }

  // ===================================================================
  //  TYPED CONTRACTS  (mock implementations)
  // ===================================================================
  var mock = {
    /** createIntent(req:{cta,offer,service,assistant,customerType,existingEpic,campaign,referral,source,consent,payload})
     *  -> {intentId, stage:'intent_created'} */
    createIntent: function (req) {
      return delay().then(function () {
        if (!req || !req.cta) return fail('VALIDATION', 'CTA id is required', { recovery: 'fix_input' });
        if (forced(req) === 'service_error') return fail('SERVICE_UNAVAILABLE', 'A service was temporarily unavailable. Your details are safe.', { recovery: 'retry' });
        if (req.consent === false) return fail('CONSENT_REQUIRED', 'Consent not granted', { recovery: 'request_consent' });
        var key = req.idempotencyKey || (req.cta + ':' + (req.payload && req.payload.contact || ''));
        if (_seen[key]) return ok({ intentId: _seen[key], stage: 'intent_created', duplicate: true });
        var id = cid('lead');
        _seen[key] = id;
        _store.leads[id] = { id: id, cta: req.cta, offer: req.offer, service: req.service, assistant: req.assistant || null,
          customerType: req.customerType, existingEpic: !!req.existingEpic, campaign: req.campaign, referral: req.referral,
          source: req.source, consent: !!req.consent, stage: 'intent_created', ts: Date.now() };
        return ok({ intentId: id, stage: 'intent_created' });
      });
    },
    /** qualify(req:{intentId, answers}) -> {qualified, needs, recommendedOffer} */
    qualify: function (req) {
      return delay().then(function () {
        if (forced(req) === 'human_takeover') return assisted({ stage: 'qualification_started', handoff: 'chatwoot', reason: 'complex_need' });
        var lead = _store.leads[req && req.intentId];
        if (!lead) return fail('NOT_FOUND', 'Unknown intent', { recovery: 'restart' });
        lead.stage = 'qualification_completed';
        return ok({ qualified: true, stage: 'qualification_completed',
          needs: (req.answers || {}), recommendedOffer: recommend(lead, req.answers) });
      });
    },
    /** recommend(req:{intentId, answers}) -> {offer, rationale, addons, alternatives} */
    recommend: function (req) {
      return delay().then(function () {
        var lead = _store.leads[req && req.intentId] || {};
        var rec = recommend(lead, req && req.answers);
        return ok({ stage: 'recommendation_shown', offer: rec, rationale: 'Matched to stated need; assistant optional.',
          addons: ['business_receptionist'], alternatives: ['business_line', 'smart_front_desk'] });
      });
    },
    /** requestProposal(req:{intentId, offer}) -> {proposalId, stage:'proposal_requested', mode:'assisted'} */
    requestProposal: function (req) {
      return delay().then(function () {
        if (forced(req) === 'unavailable') return fail('UNAVAILABLE', 'Offer requires manual scoping', { recovery: 'human_takeover' });
        return assisted({ proposalId: cid('prop'), stage: 'proposal_requested', note: 'A person prepares the proposal; no price invented by the assistant.' });
      });
    },
    /** commitmentStatus(req:{proposalId}) -> {stage, state:'started|confirmed'} */
    commitmentStatus: function (req) {
      return delay().then(function () {
        if (forced(req) === 'pending') return pending({ stage: 'commitment_started', state: 'awaiting_customer' });
        return ok({ stage: 'commitment_confirmed', state: 'confirmed' });
      });
    },
    /** paymentStatus(req:{commitmentId}) -> success|payment_pending|payment_failed */
    paymentStatus: function (req) {
      return delay().then(function () {
        var s = forced(req);
        if (s === 'payment_pending') return pending({ stage: 'payment_pending', message: 'Awaiting EPIC payment confirmation. No money taken yet.' });
        if (s === 'payment_failed') return fail('PAYMENT_FAILED', "Payment didn't complete. No money was taken.", { recovery: 'retry_offer_kept' });
        return ok({ stage: 'payment_confirmed', method: '[placeholder]', authority: 'EPIC · Isola/Odoo' });
      });
    },
    /** createCustomer(req:{intentId, profile}) -> {customerId} (Isola identity) */
    createCustomer: function (req) {
      return delay().then(function () {
        if (forced(req) === 'duplicate') return ok({ customerId: 'cust_existing', stage: 'customer_created', duplicate: true });
        var id = cid('cust'); _store.customers[id] = { id: id, profile: req && req.profile || {} };
        return ok({ customerId: id, stage: 'customer_created', authority: 'Isola' });
      });
    },
    /** createWorkspace(req:{customerId, entitlements}) -> {workspaceId} */
    createWorkspace: function (req) {
      return delay().then(function () { return ok({ workspaceId: cid('ws'), stage: 'workspace_created', authority: 'Isola' }); });
    },
    /** activateService(req:{workspaceId, service}) -> pending provisioning */
    activateService: function (req) {
      return delay().then(function () {
        if (forced(req) === 'provisioning_failed') return fail('PROVISIONING_FAILED', 'Magnus provisioning failed', { recovery: 'rollback_or_retry', authority: 'Magnus' });
        return pending({ stage: 'provisioning_started', service: req && req.service, authority: 'Magnus (voice) · Isola (governed)' });
      });
    },
    /** activateAssistant(req:{workspaceId, assistant}) -> assisted (never for comms-only) */
    activateAssistant: function (req) {
      return delay().then(function () {
        if (!req || !req.assistant) return fail('VALIDATION', 'No assistant requested — communications-only customer', { recovery: 'skip' });
        if (req.assistant === 'voice_ai') return fail('UNSUPPORTED', 'Voice AI agent is not an approved product', { recovery: 'human_takeover' });
        return assisted({ stage: 'assistant_activation', assistant: req.assistant, authority: 'Clawith (tenant-isolated) · Isola', note: 'Business-scoped; verified before enable.' });
      });
    },
    /** connectChannel(req:{workspaceId, channel:'whatsapp'}) -> assisted (Meta Embedded Signup) */
    connectChannel: function (req) {
      return delay().then(function () { return assisted({ stage: 'channel_connection', channel: (req && req.channel) || 'whatsapp', via: 'Meta Embedded Signup' }); });
    },
    /** provisioningStatus(req:{workspaceId}) -> success|partial|pending|failed */
    provisioningStatus: function (req) {
      return delay().then(function () {
        var s = forced(req);
        if (s === 'partial') return pending({ stage: 'provisioning_completed', partial: true, remaining: ['wa_calling_verification'] });
        if (s === 'provisioning_failed') return fail('PROVISIONING_FAILED', 'A step failed', { recovery: 'rollback_or_retry' });
        return ok({ stage: 'provisioning_completed', complete: true });
      });
    },
    /** firstUseStatus(req:{workspaceId}) -> {firstUse:true} */
    firstUseStatus: function (req) { return delay().then(function () { return ok({ stage: 'first_use', firstUse: true }); }); },
    /** acceptance(req:{workspaceId, pass}) -> passed | rollback */
    acceptance: function (req) {
      return delay().then(function () {
        if (forced(req) === 'rollback' || (req && req.pass === false))
          return fail('ACCEPTANCE_FAILED', 'UAT not accepted — stays in supported stabilization', { recovery: 'rollback', stage: 'acceptance_started' });
        return ok({ stage: 'acceptance_passed' });
      });
    },
    /** supportRequest(req:{customerId, message}) -> assisted (Chatwoot) */
    supportRequest: function (req) { return delay().then(function () { return assisted({ stage: 'support_requested', channel: 'chatwoot', ticket: cid('tkt') }); }); },
    /** resumeJourney(req:{intentId}) -> {stage, resumeUrl} */
    resumeJourney: function (req) {
      return delay().then(function () {
        var lead = _store.leads[req && req.intentId];
        if (!lead) return fail('NOT_FOUND', 'No saved journey', { recovery: 'restart' });
        return ok({ stage: lead.stage, resumeUrl: '#/resume/' + lead.id, note: 'Progress preserved.' });
      });
    },
    /** track(event) -> {accepted:true} (analytics contract) */
    track: function (event) {
      return delay(40).then(function () {
        var e = Object.assign({ ts: Date.now(), correlationId: cid('evt') }, event || {});
        (config._sink || function () {})(e);
        return ok({ accepted: true, event: e.name });
      });
    },
    catalog: function () { return delay(30).then(function () { return ok(CATALOG); }); }
  };

  function recommend(lead, answers) {
    answers = answers || {};
    if (lead.existingEpic) return 'pbx_ai_upgrade';
    if (answers.wantAssistant === false) return lead.service || 'business_line';
    if (answers.needFullSystem) return 'smart_office';
    if (lead.service === 'personal_line' || answers.personal) return 'personal_line';
    if (answers.wantAssistant) return 'smart_front_desk';
    return lead.service || 'business_line';
  }

  // ===================================================================
  //  REAL adapter stub — same shape, hits baseUrl. Not wired until launch.
  // ===================================================================
  function realCall(name) {
    return function (req) {
      return fetch(config.baseUrl + '/' + name, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': cid('cor'),
          'Idempotency-Key': (req && req.idempotencyKey) || cid('idem'), 'Authorization': config.token ? ('Bearer ' + config.token) : '' },
        body: JSON.stringify(req || {})
      }).then(function (r) { return r.json(); });
    };
  }
  var real = {}; Object.keys(mock).forEach(function (k) { real[k] = realCall(k); });

  // ===================================================================
  //  PUBLIC FACADE
  // ===================================================================
  var api = {};
  Object.keys(mock).forEach(function (k) {
    api[k] = function (req) { return (config.mode === 'real' ? real : mock)[k](req); };
  });
  api.configure = function (opts) { Object.assign(config, opts || {}); return config; };
  api.onEvent = function (fn) { config._sink = fn; };
  api.getConfig = function () { return Object.assign({}, config); };
  api.CATALOG = CATALOG;
  api.contracts = Object.keys(mock);

  root.IsolaServices = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IsolaServices: api };
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this
);
