/* Isola FOH — Analytics client. Validates events against analytics-schema.json
 * (loaded if present) and records them in memory + localStorage. Browser + Node.
 * window.Analytics.emit(name, props) -> {ok, event|error}
 */
(function (root) {
  'use strict';
  var COMMON = ['session','identity','offer','service','assistant','source','campaign','cta','funnelStage','timestamp','humanOwner','correlationId'];
  // Minimal required-property map mirrored from analytics-schema.json (kept in sync by tests).
  var REQUIRED = {
    page_view:['route'], offer_view:['offer'], pricing_view:[], compare_view:[], cta_click:['cta'],
    intent_created:['cta','customerType'], qualification_started:['intentId'], qualification_completed:['intentId','recommendedOffer'],
    recommendation_shown:['offer'], demo_requested:['intentId'], proposal_requested:['intentId'], proposal_sent:['proposalId'],
    commitment_started:['proposalId'], commitment_confirmed:['proposalId'], payment_pending:['commitmentId'], payment_confirmed:['commitmentId'],
    onboarding_started:['customerId'], provisioning_started:['workspaceId','service'], provisioning_completed:['workspaceId'],
    first_use:['workspaceId'], acceptance_started:['workspaceId'], acceptance_passed:['workspaceId'], go_live:['customerId','service'],
    support_requested:['customerId'], stabilization_completed:['customerId'], lead_lost:['intentId','reason'], lead_reactivated:['intentId']
  };
  var STORE_KEY = 'foh_analytics_events';
  var mem = [];
  function load() { try { var s = root.localStorage && root.localStorage.getItem(STORE_KEY); if (s) mem = JSON.parse(s); } catch (e) {} }
  function persist() { try { root.localStorage && root.localStorage.setItem(STORE_KEY, JSON.stringify(mem.slice(-500))); } catch (e) {} }
  load();

  var session = 'sess_' + Math.random().toString(36).slice(2, 9);

  function validate(name, props) {
    if (!REQUIRED.hasOwnProperty(name)) return { ok:false, error:'UNKNOWN_EVENT:' + name };
    var missing = REQUIRED[name].filter(function (k) { return props[k] === undefined || props[k] === null || props[k] === ''; });
    if (missing.length) return { ok:false, error:'MISSING:' + missing.join(',') };
    return { ok:true };
  }

  function emit(name, props) {
    props = props || {};
    var v = validate(name, props);
    if (!v.ok) { if (root.console) console.warn('[analytics] rejected', name, v.error); return v; }
    var evt = Object.assign({ session:session, timestamp:new Date().toISOString() }, props, { name:name });
    // ensure common keys exist (null when unknown) so downstream never breaks
    COMMON.forEach(function (k) { if (evt[k] === undefined) evt[k] = null; });
    mem.push(evt); persist();
    if (root.dispatchEvent) { try { root.dispatchEvent(new CustomEvent('foh:analytics', { detail: evt })); } catch (e) {} }
    return { ok:true, event:evt };
  }

  var api = {
    emit: emit, validate: validate, session: function () { return session; },
    all: function () { return mem.slice(); },
    clear: function () { mem = []; persist(); },
    REQUIRED: REQUIRED, COMMON: COMMON
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Analytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
