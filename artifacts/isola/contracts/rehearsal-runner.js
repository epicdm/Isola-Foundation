/* Isola FOH — Executable rehearsal runner (browser + Node).
 * Contains the 18 scenario functions AND their exact-field assertions.
 * Browser:  load service-adapter.js then this; await RehearsalRunner.run().
 * Node:     node rehearsal-runner.js   (writes rehearsal-evidence.json, exits non-zero on any failure)
 */
(function (root) {
  'use strict';

  function get(o, p) { return p.split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }

  // Each scenario: run(S) -> adapter result; assert(res) -> [{field,expected,actual,pass}]
  var SCENARIOS = [
    { id:'S01', name:'Business Line — no assistant', fix:{service:'business_line'}, calls:['activateService'],
      run:function(S){ return S.activateService({workspaceId:'w',service:'business_line'}); },
      assert:function(r){ return [
        ck('status','pending',r.status), ck('data.stage','provisioning_started',get(r,'data.stage')),
        ck('data.service','business_line',get(r,'data.service')), ckContains('data.authority','Magnus',get(r,'data.authority')) ]; } },
    { id:'S02', name:'Hosted PBX — no assistant', fix:{service:'hosted_pbx'}, calls:['activateService'],
      run:function(S){ return S.activateService({workspaceId:'w',service:'hosted_pbx'}); },
      assert:function(r){ return [ ck('status','pending',r.status), ck('data.stage','provisioning_started',get(r,'data.stage')), ck('data.service','hosted_pbx',get(r,'data.service')) ]; } },
    { id:'S03', name:'Existing PBX + receptionist', fix:{assistant:'business_receptionist'}, calls:['activateAssistant'],
      run:function(S){ return S.activateAssistant({workspaceId:'w',assistant:'business_receptionist'}); },
      assert:function(r){ return [ ck('status','assisted',r.status), ck('data.stage','assistant_activation',get(r,'data.stage')), ck('data.assistant','business_receptionist',get(r,'data.assistant')), ckContains('data.authority','Clawith',get(r,'data.authority')) ]; } },
    { id:'S04', name:'Smart Front Desk (complete)', fix:{answers:{wantAssistant:true}}, calls:['createIntent','recommend'],
      run:function(S){ return S.createIntent({cta:'cta_build_smart_front_desk',service:'business_line',assistant:'business_receptionist',consent:true}).then(function(i){ return S.recommend({intentId:i.data.intentId,answers:{wantAssistant:true}}); }); },
      assert:function(r){ return [ ck('status','success',r.status), ck('data.stage','recommendation_shown',get(r,'data.stage')), ck('data.offer','smart_front_desk',get(r,'data.offer')) ]; } },
    { id:'S05', name:'Standalone WA Receptionist', fix:{assistant:'business_receptionist'}, calls:['activateAssistant'],
      run:function(S){ return S.activateAssistant({workspaceId:'w',assistant:'business_receptionist'}); },
      assert:function(r){ return [ ck('status','assisted',r.status), ck('data.assistant','business_receptionist',get(r,'data.assistant')) ]; } },
    { id:'S06', name:'Personal Line — no AI (assistant skipped)', fix:{service:'personal_line'}, calls:['activateAssistant'],
      run:function(S){ return S.activateAssistant({workspaceId:'w'}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','VALIDATION',r.code), ck('recovery','skip',r.recovery) ]; } },
    { id:'S07', name:'Personal Line + EPIC Assistant', fix:{assistant:'epic_assistant'}, calls:['activateAssistant'],
      run:function(S){ return S.activateAssistant({workspaceId:'w',assistant:'epic_assistant'}); },
      assert:function(r){ return [ ck('status','assisted',r.status), ck('data.assistant','epic_assistant',get(r,'data.assistant')) ]; } },
    { id:'S08', name:'Unsupported voice-AI request', fix:{assistant:'voice_ai'}, calls:['activateAssistant'],
      run:function(S){ return S.activateAssistant({workspaceId:'w',assistant:'voice_ai'}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','UNSUPPORTED',r.code), ck('recovery','human_takeover',r.recovery) ]; } },
    { id:'S09', name:'Price question (no invent)', fix:{}, calls:['catalog'],
      run:function(S){ return S.catalog(); },
      assert:function(r){ return [ ck('status','success',r.status),
        ck('services.business_line.readiness','Assisted',get(r,'data.services.business_line.readiness')),
        ck('services.business_line.priceLabel','Contact EPIC',get(r,'data.services.business_line.priceLabel')),
        ck('services.hosted_pbx.readiness','Conditional',get(r,'data.services.hosted_pbx.readiness')),
        ck('services.personal_line.price',0.27,get(r,'data.services.personal_line.price')) ]; } },
    { id:'S10', name:'Discount request → escalate', fix:{_scenario:'unavailable'}, calls:['requestProposal'],
      run:function(S){ return S.requestProposal({intentId:'x',_scenario:'unavailable'}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','UNAVAILABLE',r.code), ck('recovery','human_takeover',r.recovery) ]; } },
    { id:'S11', name:'Human takeover', fix:{_scenario:'human_takeover'}, calls:['qualify'],
      run:function(S){ return S.qualify({intentId:'x',_scenario:'human_takeover'}); },
      assert:function(r){ return [ ck('status','assisted',r.status), ck('data.handoff','chatwoot',get(r,'data.handoff')) ]; } },
    { id:'S12', name:'Duplicate CTA submission', fix:{idempotencyKey:'dup1'}, calls:['createIntent','createIntent'],
      run:function(S){ var a={cta:'cta_dup',service:'business_line',consent:true,idempotencyKey:'dup1'}; var first;
        return S.createIntent(a).then(function(f){ first=f; return S.createIntent(a); }).then(function(second){ second._firstId=first.data.intentId; return second; }); },
      assert:function(r){ return [ ck('status','success',r.status), ck('data.duplicate',true,get(r,'data.duplicate')), ck('intentId match',r._firstId,get(r,'data.intentId')) ]; } },
    { id:'S13', name:'Payment pending', fix:{_scenario:'payment_pending'}, calls:['paymentStatus'],
      run:function(S){ return S.paymentStatus({commitmentId:'c',_scenario:'payment_pending'}); },
      assert:function(r){ return [ ck('status','pending',r.status), ck('data.stage','payment_pending',get(r,'data.stage')) ]; } },
    { id:'S14', name:'Payment failed', fix:{_scenario:'payment_failed'}, calls:['paymentStatus'],
      run:function(S){ return S.paymentStatus({commitmentId:'c',_scenario:'payment_failed'}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','PAYMENT_FAILED',r.code), ck('recovery','retry_offer_kept',r.recovery) ]; } },
    { id:'S15', name:'Provisioning failed', fix:{_scenario:'provisioning_failed'}, calls:['activateService'],
      run:function(S){ return S.activateService({workspaceId:'w',service:'hosted_pbx',_scenario:'provisioning_failed'}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','PROVISIONING_FAILED',r.code), ck('recovery','rollback_or_retry',r.recovery) ]; } },
    { id:'S16', name:'Resume interrupted journey', fix:{idempotencyKey:'res1'}, calls:['createIntent','resumeJourney'],
      run:function(S){ return S.createIntent({cta:'cta_resume_setup',service:'business_line',consent:true,idempotencyKey:'res1'}).then(function(i){ return S.resumeJourney({intentId:i.data.intentId}); }); },
      assert:function(r){ return [ ck('status','success',r.status), ck('data.stage','intent_created',get(r,'data.stage')), ckPresent('data.resumeUrl',get(r,'data.resumeUrl')) ]; } },
    { id:'S17', name:'Acceptance fails → rollback', fix:{pass:false}, calls:['acceptance'],
      run:function(S){ return S.acceptance({workspaceId:'w',pass:false}); },
      assert:function(r){ return [ ck('status','error',r.status), ck('code','ACCEPTANCE_FAILED',r.code), ck('recovery','rollback',r.recovery), ck('stage','acceptance_started',r.stage) ]; } },
    { id:'S18', name:'Support after go-live', fix:{message:'help'}, calls:['supportRequest'],
      run:function(S){ return S.supportRequest({customerId:'c',message:'help'}); },
      assert:function(r){ return [ ck('status','assisted',r.status), ck('data.channel','chatwoot',get(r,'data.channel')), ckPresent('data.ticket',get(r,'data.ticket')) ]; } }
  ];

  function ck(field, expected, actual) { return { field:field, expected:expected, actual:actual===undefined?null:actual, pass:actual===expected }; }
  function ckPresent(field, actual) { return { field:field+' present', expected:'<non-empty>', actual:actual===undefined?null:actual, pass:actual!=null && actual!=='' }; }
  function ckContains(field, sub, actual) { return { field:field+' contains "'+sub+'"', expected:sub, actual:actual===undefined?null:actual, pass:typeof actual==='string' && actual.indexOf(sub)>=0 }; }

  function resolveAdapter(adapter) {
    if (adapter) return adapter;
    if (root.IsolaServices) return root.IsolaServices;
    if (typeof require !== 'undefined') { try { var m = require('./service-adapter.js'); return (m && m.IsolaServices) || root.IsolaServices; } catch (e) {} }
    throw new Error('No IsolaServices adapter available');
  }

  function run(adapter) {
    var S = resolveAdapter(adapter);
    if (S.configure) S.configure({ latency: 0 });
    var results = [], passed = 0;
    var seq = Promise.resolve();
    SCENARIOS.forEach(function (sp) {
      seq = seq.then(function () {
        var t0 = new Date().toISOString();
        return Promise.resolve().then(function () { return sp.run(S); })
          .catch(function (e) { return { status:'error', code:'THROW', message:String(e) }; })
          .then(function (res) {
            var checks = sp.assert(res);
            var okAll = checks.every(function (c) { return c.pass; });
            if (okAll) passed++;
            results.push({ scenario:sp.id, name:sp.name, inputFixture:sp.fix, adapterCalls:sp.calls,
              fieldChecks:checks, returnedState:res, timestamp:t0, result: okAll ? 'PASS' : 'FAIL' });
          });
      });
    });
    return seq.then(function () {
      return { packet:'xp-front-of-house-launch-readiness', artifact:'W9 mock launch rehearsal (executable, exact-field)',
        adapter:'service-adapter.js', runner:'rehearsal-runner.js', mode:'mock', generatedAt:new Date().toISOString(),
        total:SCENARIOS.length, passed:passed, failed:SCENARIOS.length - passed,
        assertionPolicy:'A scenario FAILS if any expected status/code/stage/service/assistant/duplicate-id/handoff/recovery/rollback/catalogue field mismatches, even when broad status is correct.',
        results:results };
    });
  }

  var RehearsalRunner = { SCENARIOS: SCENARIOS, run: run, get: get,
    policy: 'fail on any field mismatch (status/code/stage/service/assistant/duplicate-id/handoff/recovery/rollback/catalogue)' };

  if (typeof module !== 'undefined' && module.exports) module.exports = RehearsalRunner;
  root.RehearsalRunner = RehearsalRunner;

  // Node CLI: regenerate evidence + non-zero exit on failure.
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    run().then(function (ev) {
      try { require('fs').writeFileSync('rehearsal-evidence.json', JSON.stringify(ev, null, 2)); } catch (e) {}
      // eslint-disable-next-line no-console
      console.log('REHEARSAL ' + ev.passed + '/' + ev.total + ' passed');
      if (typeof process !== 'undefined') process.exit(ev.failed ? 1 : 0);
    });
  }
})(typeof window !== 'undefined' ? window : this);
