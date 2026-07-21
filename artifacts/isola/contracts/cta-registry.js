/* Isola Front-of-House — CTA Contract Registry (machine-readable, source of truth)
 * Consumed by the frontend via typed bridge lib/foh/cta-registry.ts (no duplication).
 * Every CTA preserves context to the sales assistant / commercial path.
 * window.CTA_REGISTRY (browser) or module.exports (node).
 *
 * Call phases are separated so a marketing-page click cannot activate a service or
 * assistant, and cannot claim qualification that has not happened:
 *   frontendCalls     — run immediately on click (create/resume/support only)
 *   journeyCalls      — later, sales-assisted (qualify, recommend, requestProposal)
 *   provisioningCalls — only after commitment/onboarding/acceptance (activate*)
 * expectedAdapterCalls is the ordered union, kept for back-compat / drift tests.
 */
(function (root) {
  'use strict';

  var PAYLOAD_SCHEMA = {
    type: 'object',
    required: ['cta', 'customerType', 'consent', 'contact'],
    properties: {
      cta: { type: 'string', description: 'CTA id' },
      offer: { type: 'string|null' },
      service: { type: 'string|null', enum: ['business_line','hosted_pbx','connect_pbx','personal_line', null] },
      assistant: { type: 'string|null', enum: ['business_receptionist','sales_assistant','support_assistant','booking_assistant','account_assistant','epic_assistant', null] },
      customerType: { type: 'string', enum: ['business','personal','existing_epic'] },
      existingEpic: { type: 'boolean' },
      campaign: { type: 'string|null' },
      referral: { type: 'string|null' },
      source: { type: 'string', enum: ['search','ad','referral','whatsapp','social','email','direct'] },
      consent: { type: 'boolean', description: 'must be true to create an intent' },
      contact: { type: 'string', format: 'phone|email', description: 'real WhatsApp number or email; no placeholder bypass' }
    }
  };

  var VALIDATION = {
    consent: 'consent === true or createIntent returns CONSENT_REQUIRED',
    contact: 'a real phone (+1767…) or email is required for follow-up — no placeholder value accepted',
    customerType: 'must be one of business|personal|existing_epic',
    idempotency: 'idempotencyKey = cta + ":" + contact; duplicate returns same intentId with duplicate:true'
  };

  var STD = {
    click: "click runs frontendCalls only. success -> { status:'success', data:{ intentId, stage:'intent_created' }, correlationId }",
    clickAnalytics: "['cta_click','intent_created'] — qualification_started is emitted ONLY when qualify() is actually called (journeyCalls)",
    errors: {
      VALIDATION: "{ status:'error', code:'VALIDATION', recovery:'fix_input' }",
      CONSENT_REQUIRED: "{ status:'error', code:'CONSENT_REQUIRED', recovery:'request_consent' }"
    },
    duplicate: "{ status:'success', data:{ intentId:<existing>, duplicate:true } }",
    recovery: 'Inline field errors; resume link on abandon (resumeJourney); human takeover to Chatwoot on request.'
  };

  // default CTA: click creates an intent; qualification/recommendation happen later; no provisioning from a click.
  function cta(o) {
    var base = {
      existingEpic: false, campaign: null, referral: null, sourceChannel: 'direct',
      consentRequired: true, payloadSchema: 'PAYLOAD_SCHEMA', validation: 'VALIDATION',
      destination: '/apply',
      frontendCalls: ['createIntent'],
      journeyCalls: ['qualify', 'recommend'],
      provisioningCalls: [],
      analytics: ['cta_click', 'intent_created'],
      success: STD.click, errors: STD.errors, duplicate: STD.duplicate, recovery: STD.recovery,
      owner: 'Sales'
    };
    var merged = Object.assign(base, o);
    // ordered union for back-compat + drift checks
    merged.expectedAdapterCalls = merged.frontendCalls
      .concat(merged.journeyCalls).concat(merged.provisioningCalls)
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    return merged;
  }

  var CTAS = [
    cta({ id:'cta_business_line', label:'Set up my Business Line', sourcePage:'/business-line',
      offer:'business_line', service:'business_line', assistant:null, customerType:'business',
      provisioningCalls:['activateService'], owner:'Sales · comms' }),
    cta({ id:'cta_hosted_pbx', label:'Get a Hosted PBX', sourcePage:'/hosted-pbx',
      offer:'hosted_pbx', service:'hosted_pbx', assistant:null, customerType:'business',
      provisioningCalls:['activateService'], owner:'Sales · comms' }),
    cta({ id:'cta_connect_pbx', label:'Connect my existing PBX', sourcePage:'/connect-pbx',
      offer:'connect_pbx', service:'connect_pbx', assistant:null, customerType:'business',
      provisioningCalls:['activateService'], owner:'Sales · engineering' }),
    cta({ id:'cta_personal_line', label:'Get a Personal Line', sourcePage:'/personal-line',
      offer:'personal_line', service:'personal_line', assistant:null, customerType:'personal',
      destination:'/signup', provisioningCalls:['activateService'], owner:'Self-serve · personal' }),
    cta({ id:'cta_add_receptionist', label:'Add a Business Receptionist', sourcePage:'/assistants',
      offer:'business_receptionist', service:null, assistant:'business_receptionist', customerType:'business',
      provisioningCalls:['activateAssistant'], owner:'Sales · assistants' }),
    cta({ id:'cta_add_sales_assistant', label:'Add a Sales Assistant', sourcePage:'/assistants',
      offer:'sales_assistant', service:null, assistant:'sales_assistant', customerType:'business',
      provisioningCalls:['activateAssistant'], owner:'Sales · assistants' }),
    cta({ id:'cta_upgrade_epic_pbx', label:'Upgrade my existing EPIC PBX', sourcePage:'/pbx-ai-upgrade',
      offer:'pbx_ai_upgrade', service:'hosted_pbx', assistant:'business_receptionist', customerType:'existing_epic',
      existingEpic:true, provisioningCalls:['activateService','activateAssistant'], owner:'Account management' }),
    cta({ id:'cta_build_smart_front_desk', label:'Build a Smart Front Desk', sourcePage:'/solutions/smart-front-desk',
      offer:'smart_front_desk', service:'business_line', assistant:'business_receptionist', customerType:'business',
      journeyCalls:['qualify','recommend','requestProposal'], provisioningCalls:['activateService','activateAssistant'],
      owner:'Sales · solutions' }),
    cta({ id:'cta_talk_sales_assistant', label:'Talk to the Sales Assistant', sourcePage:'*',
      offer:null, service:null, assistant:'sales_assistant', customerType:'business',
      destination:'wa:sales', journeyCalls:['qualify'],
      analytics:['cta_click','intent_created','wa_conversation_start'], owner:'Sales' }),
    cta({ id:'cta_request_demo', label:'Request a demo', sourcePage:'/demo',
      offer:null, service:null, assistant:null, customerType:'business',
      journeyCalls:['requestProposal'], analytics:['cta_click','demo_requested'], owner:'Sales' }),
    cta({ id:'cta_apply', label:'Apply', sourcePage:'/apply',
      offer:null, service:null, assistant:null, customerType:'business',
      journeyCalls:[], analytics:['cta_click','intent_created'], owner:'Sales ops' }),
    cta({ id:'cta_resume_setup', label:'Resume setup', sourcePage:'*',
      offer:null, service:null, assistant:null, customerType:'business',
      destination:'/onboarding', frontendCalls:['resumeJourney'], journeyCalls:[],
      consentRequired:false, analytics:['cta_click','onboarding_started'],
      recovery:'resumeJourney returns saved stage + resumeUrl; NOT_FOUND -> restart', owner:'Onboarding' }),
    cta({ id:'cta_contact_support', label:'Contact support', sourcePage:'*',
      offer:null, service:null, assistant:null, customerType:'business',
      destination:'wa:support', frontendCalls:['supportRequest'], journeyCalls:[],
      consentRequired:false, analytics:['cta_click','support_requested'],
      recovery:'supportRequest -> assisted (Chatwoot ticket)', owner:'Support' })
  ];

  var api = { PAYLOAD_SCHEMA: PAYLOAD_SCHEMA, VALIDATION: VALIDATION, STD: STD, CTAS: CTAS,
    byId: function (id) { return CTAS.filter(function (c) { return c.id === id; })[0] || null; } };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTA_REGISTRY = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
