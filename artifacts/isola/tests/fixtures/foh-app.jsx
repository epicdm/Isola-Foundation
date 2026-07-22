/* Isola Foundation — Front-of-House route harness (Stage 1).
 * Renders the 9 real route components with shadcn/EPIC styling, wired to the
 * accepted contracts: window.CTA_REGISTRY, window.IsolaServices, window.Analytics.
 * This harness mirrors the repo-structured .tsx source in foh-package/ 1:1.
 */
const { useState, useEffect, useCallback, createElement: h } = React;
const R = window.CTA_REGISTRY, S = window.IsolaServices, A = window.Analytics;
const WA = 'https://wa.me/17678180001';

/* ---------- icons (lucide paths) ---------- */
function Ic({ d, ...p }) { return h('svg', { viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:2, strokeLinecap:'round', strokeLinejoin:'round', ...p }, Array.isArray(d)?d.map((x,i)=>h('path',{key:i,d:x})):h('path',{d})); }
const Check = p => h(Ic, { d:'M20 6 9 17l-5-5', ...p });
const X = p => h(Ic, { d:'M18 6 6 18M6 6l12 12', ...p });
const Arrow = p => h(Ic, { d:'M5 12h14M12 5l7 7-7 7', ...p });
const Wa = p => h(Ic, { d:'M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2Z', ...p });
const Spark = p => h(Ic, { d:['M12 3v18','M3 12h18','m5.6 5.6 12.8 12.8','m18.4 5.6-12.8 12.8'], ...p });

/* ---------- readiness badge (engine vs Isola experience) ---------- */
const RCLASS = { Live:'rp-live', Assisted:'rp-assisted', Conditional:'rp-conditional', Planned:'rp-planned', 'Not offered':'rp-planned' };
function Readiness({ state }) { return h('span', { className:'rp ' + (RCLASS[state]||'rp-planned') }, h('span',{className:'d'}), state); }
function DualState({ engine, isola }) {
  return h('div', { style:{ display:'flex', gap:14, flexWrap:'wrap' } },
    h('div', null, h('div',{style:{fontSize:11,color:'var(--muted-foreground)',fontWeight:600,marginBottom:4}},'Engine state'), h(Readiness,{state:engine})),
    h('div', null, h('div',{style:{fontSize:11,color:'var(--muted-foreground)',fontWeight:600,marginBottom:4}},'Isola experience'), h(Readiness,{state:isola})));
}

/* ================= CATALOG — grounded in Port + claim-guard (EC$ only; ratified {750,249,250,99,149,375,187.5,124.5,499.5}, EC$0.27/min) ================= */
const PRICE = {
  contact: { label:'Contact EPIC', note:'Pricing confirmed by EPIC before any work begins.' },
  sfd: { label:'EC$750', unit:' setup', note:'Two EC$375 installments — before work, then at acceptance · EC$249/mo · voice balance separate. Founding promo (first 3 customers): EC$375 setup (two EC$187.50 installments) · EC$124.50/mo for months 1–3, then EC$249/mo.' },
  war: { label:'EC$250', unit:' setup', note:'EC$149/mo · no new voice line or PBX included.' },
  pbxup: { label:'EC$250', unit:' setup', note:'EC$99/mo · existing voice charges separate.' },
  personal: { label:'EC$0.27', unit:'/min', note:'Prepaid wallet · calling billed per minute.' },
};

const PRODUCTS = {
  business_line: {
    route:'/business-line', kind:'Communications service', eyebrow:'Communications · Business Line',
    title:'A business line that answers — even when you can’t.',
    sub:'A business WhatsApp number and supported calling for your team, set up and managed by EPIC. No assistant required.',
    engine:'Live', isola:'Assisted', price:PRICE.contact,
    included:['Business WhatsApp and supported calling configuration','One or more approved SIP accounts','Acrobits or endpoint access','Optional PSTN DID','Prepaid calling wallet','Voicemail, forwarding and approved fallback'],
    optional:['Add a Business Receptionist assistant (optional)','Upgrade to a complete Smart Front Desk'],
    exclusions:['No assistant is required to use this service','WhatsApp inbound calling is conditional where number and route verification are required'],
    primary:'cta_business_line', secondary:'cta_talk_sales_assistant',
  },
  hosted_pbx: {
    route:'/hosted-pbx', kind:'Communications service', eyebrow:'Communications · Hosted PBX',
    title:'A complete phone system for your team.',
    sub:'Extensions, aliases, IVR, queues, voicemail and routing on EPIC’s mature hosted PBX — usable without any assistant.',
    engine:'Live', isola:'Conditional', price:PRICE.contact,
    included:['SIP users and endpoints','Four-digit internal aliases','IVR, queues or ring groups','Voicemail, hours and routing','Optional DIDs','Ordinary inbound and outbound calling','Balances and CDRs'],
    optional:['Add a Business Receptionist','Add a Sales Assistant','Add a Support Assistant'],
    exclusions:['The packaged Isola experience is Conditional until governed provisioning and end-to-end acceptance are proven','No assistant is bundled unless you choose an assistant-inclusive package'],
    primary:'cta_hosted_pbx', secondary:'cta_request_demo',
  },
  connect_pbx: {
    route:'/connect-pbx', kind:'Communications service', eyebrow:'Communications · Connect Existing PBX',
    title:'Keep your PBX. Add WhatsApp calling.',
    sub:'Route inbound WhatsApp calls and optional EPIC voice into the PBX, SBC or SIP trunk you already run.',
    engine:'Live', isola:'Conditional', price:PRICE.contact,
    included:['WhatsApp inbound calling into your existing PBX/SBC/SIP trunk','Customer-specific route test','Optional EPIC DID','CDR visibility','Failover configuration','Guided integration by EPIC'],
    optional:['Add an Isola Receptionist','Add a Support Assistant'],
    exclusions:['AI reception is optional, not required','The customer-specific route is Conditional until it passes the approved route acceptance test'],
    primary:'cta_connect_pbx', secondary:'cta_talk_sales_assistant',
  },
  personal_line: {
    route:'/personal-line', kind:'Communications service', eyebrow:'Communications · Personal Line',
    title:'Your own Dominica line for calling home.',
    sub:'A personal Dominica number with a prepaid wallet and app calling. Usable on its own — no assistant to activate.',
    engine:'Live', isola:'Conditional', price:PRICE.personal,
    included:['Personal Dominica number','Progressive web app (PWA)','Acrobits softphone','Prepaid wallet and top-ups','Calling plans or bundles','Usage and balance','Support'],
    optional:['EPIC Assistant available where verified (optional support benefit)','Personal Assistant / Personal AI+ (Planned)'],
    exclusions:['You are never required to activate or interact with an assistant','Personal AI+ is Planned — pricing, metering and spending controls unresolved'],
    primary:'cta_personal_line', secondary:'cta_contact_support',
  },
  smart_front_desk: {
    route:'/solutions/smart-front-desk', kind:'Complete solution', eyebrow:'Complete solution · Smart Front Desk',
    title:'A front desk that never misses a customer.',
    sub:'Business Line + a Business Receptionist + shared inbox + supported calling, set up and managed by EPIC end to end.',
    engine:'Live', isola:'Assisted', price:PRICE.sfd,
    included:['Business Line (WhatsApp + supported calling)','Business Receptionist assistant','Shared inbox with human takeover','Supported calling configuration','Human escalation'],
    optional:['Add extra assistants (Sales, Support) later','Grow into a Hosted PBX'],
    exclusions:['Voice balance is billed separately','Delivered as a managed, assisted setup — not instant self-service'],
    primary:'cta_build_smart_front_desk', secondary:'cta_request_demo',
  },
};

const ASSISTANTS = [
  { id:'business_receptionist', title:'Business Receptionist', job:'Greets and routes every WhatsApp enquiry', state:'Assisted', price:PRICE.war, cta:'cta_add_receptionist',
    outcomes:['Approved WhatsApp responses','Lead and enquiry capture','Shared inbox','Human takeover','After-hours assistance'], channels:['WhatsApp'], works:['Business Line','Hosted PBX','Connect Existing PBX'] },
  { id:'sales_assistant', title:'Sales Assistant', job:'Follows up with every enquiry', state:'Conditional', price:PRICE.contact, cta:'cta_add_sales_assistant',
    outcomes:['Enquiry follow-up','Lead qualification','CRM follow-up notes','Human handoff for offers/pricing'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'support_assistant', title:'Support Assistant', job:'Answers common questions, escalates the rest', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant',
    outcomes:['Deflects common questions','Human escalation','Shared inbox'], channels:['WhatsApp'], works:['Hosted PBX','Connect Existing PBX'] },
  { id:'booking_assistant', title:'Booking Assistant', job:'Captures and confirms booking requests', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant',
    outcomes:['Booking capture','Confirmation messaging','Human handoff'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'account_assistant', title:'Account Assistant', job:'Helps customers with their own account', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant',
    outcomes:['Own-account help','Balance and usage questions','Human escalation'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'epic_assistant', title:'EPIC Assistant', job:'Explains EPIC services and helps with your own account', state:'Conditional', price:{label:'Available where verified',note:'Included support benefit on Personal Line where verified.'}, cta:'cta_contact_support',
    outcomes:['Explains EPIC services','Signup assistance','Own approved account info','Activation and top-up guidance','Escalates to a person'], channels:['WhatsApp'], works:['Personal Line'] },
  { id:'personal_assistant', title:'Personal Assistant', job:'Broader personal assistance', state:'Planned', price:PRICE.contact, cta:'cta_contact_support',
    outcomes:['Broader approved skills (Planned)','Wallet-funded (Planned)'], channels:['WhatsApp'], works:['Personal Line'] },
  { id:'custom_assistant', title:'Custom Assistant', job:'A scoped assistant for your workflow', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant',
    outcomes:['Scoped approved tools','Defined permissions','Human escalation'], channels:['WhatsApp'], works:['Hosted PBX','Business Line'] },
];

const ROUTES = [
  { path:'/products', label:'Overview' },
  { path:'/communications', label:'Phone services' },
  { path:'/assistants', label:'Assistants' },
  { path:'/solutions', label:'Solutions' },
];

/* ================= CTA engine — mirrors lib/foh/use-cta.ts 1:1 =================
 * A click runs the contract's frontendCalls ONLY (createIntent / resumeJourney /
 * supportRequest). It never runs journeyCalls or provisioningCalls, so it cannot
 * activate a service/assistant, and qualification_started is NOT emitted on a click. */
function isValidContact(v){ if(!v) return false; const s=String(v).trim();
  if (/^\+?[0-9(][0-9 ()-]{6,}$/.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true; return false; }
function useCta() {
  const [state, setState] = useState({ phase:'idle' });
  const run = useCallback(async (ctaId, opts) => {
    opts = opts || {};
    const rec = R.byId(ctaId);
    if (!rec) { setState({ phase:'error', code:'NO_CTA', msg:'Unknown CTA: ' + ctaId }); return; }
    A.emit('cta_click', { cta:ctaId, offer:rec.offer, service:rec.service, assistant:rec.assistant, source:rec.sourceChannel, campaign:rec.campaign, funnelStage:'Acquire' });
    if (rec.consentRequired && !opts.consent) { setState({ phase:'validation', code:'CONSENT_REQUIRED', msg:'Please agree to be contacted so EPIC can follow up.' }); return; }
    const front = (rec.frontendCalls && rec.frontendCalls[0]) || 'createIntent';
    setState({ phase:'loading' });
    try {
      if (front === 'supportRequest') { const r = await S.supportRequest({ message:'Support request from '+ctaId, contact:opts.contact });
        setState({ phase:'success', corr:r.correlationId, msg:'A person will help you on WhatsApp.' }); return; }
      if (front === 'resumeJourney') { const r = await S.resumeJourney({ intentId:opts.intentId||'unknown' });
        if (r.status==='error') setState({ phase:'recovery', code:r.code, msg:r.message });
        else setState({ phase:'success', corr:r.correlationId, resumed:r.data && r.data.resumeUrl }); return; }
      // createIntent path requires a REAL contact (no placeholder bypass)
      if (!isValidContact(opts.contact)) { setState({ phase:'validation', code:'CONTACT_REQUIRED', msg:'Enter a real WhatsApp number or email so EPIC can reach you.' }); return; }
      const idem = ctaId + ':' + opts.contact;
      const payload = { cta:ctaId, offer:rec.offer, service:rec.service, assistant:rec.assistant,
        customerType:rec.customerType, existingEpic:rec.existingEpic, campaign:rec.campaign,
        referral:rec.referral, source:rec.sourceChannel, consent:!!opts.consent, contact:opts.contact,
        idempotencyKey:idem, _scenario:opts.scenario };
      const res = await S.createIntent(payload);
      const corr = res.correlationId;
      if (res.status === 'error') {
        A.emit('lead_lost', { intentId:'n/a', reason:res.code||'error' });
        setState({ phase:'error', code:res.code, msg:res.message||'Something went wrong.', corr, retry:()=>run(ctaId, opts) });
        return;
      }
      const intentId = res.data && res.data.intentId;
      A.emit('intent_created', { cta:ctaId, customerType:rec.customerType, service:rec.service, assistant:rec.assistant, correlationId:corr });
      setState({ phase:'success', intentId, corr, rec,
        resume:async()=>{ const rr = await S.resumeJourney({ intentId }); setState(s=>({ ...s, resumed:rr.data && rr.data.resumeUrl })); } });
    } catch (e) {
      setState({ phase:'error', code:'NETWORK', msg:String(e), retry:()=>run(ctaId, opts) });
    }
  }, []);
  return [state, run, ()=>setState({ phase:'idle' })];
}

/* ---------- purchase / CTA panel with all states ---------- */
function CtaPanel({ product, forceState }) {
  const [state, run, reset] = useCta();
  const [consent, setConsent] = useState(false);
  const [contact, setContact] = useState('');
  const rec = R.byId(product.primary), sec = R.byId(product.secondary);
  const phase = forceState && forceState !== 'live' ? forceState : state.phase;

  return h('div', { className:'card card-pad aside' },
    h('div', { style:{ marginBottom:12 } }, h(DualState, { engine:product.engine, isola:product.isola })),
    h('div', { className:'price', style:{ marginTop:14 } }, product.price.label, product.price.unit ? h('span', null, product.price.unit) : null),
    h('div', { className:'muted', style:{ fontSize:12.5, marginTop:6, lineHeight:1.5 } }, product.price.note),
    h('div', { className:'subcard' },
      h('label', { style:{ display:'block', fontSize:12.5, fontWeight:600, marginBottom:5 } }, 'WhatsApp number or email'),
      h('input', { value:contact, onChange:e=>setContact(e.target.value), placeholder:'+1 767 000 0000',
        style:{ width:'100%', padding:'8px 10px', borderRadius:8, border:'1px solid var(--input)', fontSize:13.5, fontFamily:'inherit', background:'var(--background)', color:'var(--foreground)' } }),
      h('label', { style:{ display:'flex', gap:8, alignItems:'flex-start', fontSize:12.5, marginTop:10, cursor:'pointer', color:'var(--muted-foreground)' } },
        h('input', { type:'checkbox', checked:consent, onChange:e=>setConsent(e.target.checked), style:{ marginTop:2 } }),
        'I agree that EPIC may contact me about this request.')),
    h('div', { style:{ display:'flex', flexDirection:'column', gap:9, marginTop:14 } },
      h('button', { className:'btn btn-default btn-lg', disabled:phase==='loading',
        onClick:()=>run(product.primary, { consent, contact, scenario:forceState==='service_error'?'service_error':undefined }) },
        phase==='loading' ? h('span',{className:'spin'}) : h(Arrow), rec ? rec.label : 'Get started'),
      h('button', { className:'btn btn-outline', onClick:()=>run(product.secondary, { consent:true, contact }) }, sec ? sec.label : 'Talk to sales')),
    h('a', { className:'btn btn-ghost btn-sm', href:WA, target:'_blank', style:{ marginTop:8, width:'100%', color:'var(--muted-foreground)' } }, h(Wa), 'Talk to a person on WhatsApp'),
    h(StateView, { phase, state, reset }));
}

function StateView({ phase, state, reset }) {
  if (phase === 'idle') return null;
  if (phase === 'loading') return h('div', { className:'state state-load' }, h('span',{className:'spin'}), 'Sending your request to EPIC…');
  if (phase === 'validation') return h('div', { className:'state state-warn' }, h(Ic,{d:'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'}), state.msg || 'Please complete the required fields.');
  if (phase === 'service_error' || phase === 'error') return h('div', { className:'state state-err' }, h(X), h('div', null,
    h('div', { style:{ fontWeight:600 } }, 'We couldn’t submit that just now', state.code?h('span',{style:{fontWeight:400}},' ('+state.code+')'):null),
    h('div', null, state.msg || 'A service was temporarily unavailable. Your details are safe.'),
    h('div', { style:{ marginTop:8, display:'flex', gap:8 } },
      h('button', { className:'btn btn-outline btn-sm', onClick:state.retry||reset }, 'Try again'),
      h('a', { className:'btn btn-ghost btn-sm', href:WA, target:'_blank' }, 'Message EPIC instead')),
    state.corr?h('div',{className:'corr'},'ref '+state.corr):null));
  if (phase === 'recovery') return h('div', { className:'state state-warn' }, h(Ic,{d:'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8'}), 'Your setup was paused. Pick up where you left off — nothing was lost.');
  if (phase === 'success') return h('div', { className:'state state-ok' }, h(Check), h('div', null,
    h('div', { style:{ fontWeight:600 } }, 'Request received — EPIC will follow up.'),
    h('div', null, 'A person reviews every request. You’ll hear back on WhatsApp to confirm and begin assisted setup.'),
    state.resume?h('button',{className:'btn btn-ghost btn-sm',style:{marginTop:8},onClick:state.resume},'Resume later'):null,
    state.resumed?h('div',{className:'corr'},'resume: '+state.resumed):null,
    state.corr?h('div',{className:'corr'},'ref '+state.corr):null));
  return null;
}

/* ---------- shared chrome ---------- */
function Nav({ go, path }) {
  return h('nav', { className:'nav' }, h('div', { className:'wrap nav-in' },
    h('a', { className:'logo', onClick:()=>go('/products') }, h('span',{className:'mk'},'I'), 'Isola'),
    h('div', { className:'nav-links' }, ROUTES.map(r=>h('a',{key:r.path,className:path===r.path?'on':'',onClick:()=>go(r.path)},r.label))),
    h('div', { className:'nav-cta' },
      h('a', { className:'btn btn-ghost btn-sm', href:'/auth/login', onClick:e=>e.preventDefault() }, 'Sign in'),
      h('button', { className:'btn btn-default btn-sm', onClick:()=>go('/products') }, 'Explore Isola')),
    h('button', { className:'nav-burger' }, h(Ic,{d:['M3 12h18','M3 6h18','M3 18h18']}))));
}
function Footer({ go }) {
  return h('footer', { className:'footer' }, h('div', { className:'wrap' },
    h('div', { className:'foot-grid' },
      h('div', null, h('a',{className:'logo',onClick:()=>go('/products')},h('span',{className:'mk'},'I'),'Isola'),
        h('p',{className:'muted',style:{fontSize:13.5,marginTop:10,maxWidth:'32ch'}},'Phone services and assistants for Caribbean businesses and people — set up and supported by EPIC Communications.')),
      h('div', null, h('h4',null,'Phone services'), ['business_line','hosted_pbx','connect_pbx','personal_line'].map(k=>h('a',{key:k,onClick:()=>go(PRODUCTS[k].route)},PRODUCTS[k].eyebrow.split('· ')[1]))),
      h('div', null, h('h4',null,'Assistants'), h('a',{onClick:()=>go('/assistants')},'All assistants'), h('a',{onClick:()=>go(PRODUCTS.smart_front_desk.route)},'Smart Front Desk')),
      h('div', null, h('h4',null,'Company'), h('a',{href:WA,target:'_blank'},'Talk to EPIC on WhatsApp'), h('a',{href:'/auth/login',onClick:e=>e.preventDefault()},'Customer sign in'))),
    h('div', { className:'foot-bot' }, h('span',null,'© 2026 EPIC · Powered by Isola'), h('span',null,'Controlled launch · assisted setup by EPIC'))));
}
function Hero({ eyebrow, title, titleGrad, sub, ctas, go }) {
  return h('header', { className:'hero' }, h('div', { className:'wrap' },
    h('span', { className:'eyebrow' }, eyebrow),
    h('h1', null, title, titleGrad?[' ',h('span',{key:'g',className:'g'},titleGrad)]:null),
    sub?h('p',{className:'sub'},sub):null,
    ctas?h('div',{className:'hero-cta'},ctas):null,
    h('div', { className:'hero-trust' }, h(Readiness,{state:'Assisted'}), h('span',null,'Assisted setup by EPIC'), h('span',{style:{opacity:.4}},'·'), h('span',null,'Controlled launch'))));
}

/* ================= PAGES ================= */
function ProductPage({ pkey, go, forceState }) {
  const p = PRODUCTS[pkey];
  useEffect(()=>{ A.emit('offer_view', { offer:pkey, service:p.route }); },[pkey]);
  const list = (items, cls, icon) => h('ul', { className:'feat '+(cls||'') }, items.map((t,i)=>h('li',{key:i}, icon, t)));
  return h('div', null,
    h('div', { className:'wrap' }, h('div', { className:'prod' },
      h('div', null,
        h('span', { className:'eyebrow' }, p.eyebrow),
        h('span', { className:'badge badge-secondary', style:{ marginLeft:10 } }, p.kind),
        h('h1', { style:{ fontSize:'clamp(28px,4vw,44px)', fontWeight:800, margin:'14px 0 0' } }, p.title),
        h('p', { className:'muted', style:{ fontSize:17, marginTop:14, lineHeight:1.6, maxWidth:'54ch' } }, p.sub),
        h('h3', { style:{ marginTop:30, fontSize:15 } }, 'What’s included'), list(p.included, '', h(Check,{width:16,height:16})),
        h('h3', { style:{ marginTop:24, fontSize:15 } }, 'Optional additions'), list(p.optional, '', h(Spark,{width:15,height:15})),
        h('h3', { style:{ marginTop:24, fontSize:15 } }, 'Not included'), list(p.exclusions, 'excl', h(X,{width:15,height:15}))),
      h('div', null, h(CtaPanel, { product:p, forceState })))),
    h(Footer, { go }));
}

function PortfolioHome({ go }) {
  useEffect(()=>{ A.emit('page_view', { route:'/products' }); },[]);
  const cat = (n, title, desc, to) => h('div', { className:'card card-pad', style:{cursor:'pointer'}, onClick:()=>go(to) },
    h('div',{className:'n'},n), h('h3',null,title), h('p',{className:'kd'},desc),
    h('div',{style:{marginTop:14,color:'var(--primary)',fontWeight:600,fontSize:14,display:'flex',gap:6,alignItems:'center'}},'Explore ',h(Arrow,{width:15,height:15})));
  const choice = (n, t, d, to) => h('div', { className:'card card-pad', style:{cursor:'pointer'}, onClick:()=>go(to) },
    h('div',{className:'n'},n), h('div',{style:{fontWeight:700,fontSize:15}},t), h('p',{className:'kd',style:{marginTop:6}},d));
  return h('div', null,
    h(Hero, { eyebrow:'Isola · by EPIC Communications', title:'Phone services and assistants,', titleGrad:'run with you.',
      sub:'Get a business line, a complete phone system, or a personal Dominica number — and add an assistant only if you want one. Set up and supported by EPIC.',
      ctas:[ h('button',{key:1,className:'btn btn-default btn-lg',onClick:()=>go('/communications')}, h(Arrow),'Explore phone services'),
             h('a',{key:2,className:'btn btn-outline btn-lg',href:WA,target:'_blank'}, h(Wa),'Talk to our sales assistant') ], go }),
    h('section', { className:'sec' }, h('div', { className:'wrap' },
      h('div', { className:'sec-head' }, h('h2',null,'Three ways to start'), h('p',null,'Pick the category that fits — you can always add to it later.')),
      h('div', { className:'grid g3' },
        cat('1','Phone & communication services','Business Line, Hosted PBX, Connect Existing PBX and Personal Line. Numbers and calling that work on their own.','/communications'),
        cat('2','Digital assistants','A receptionist, sales, booking or support assistant you can add to a service you already have.','/assistants'),
        cat('3','Complete solutions','Communications and an assistant packaged together — like the Smart Front Desk.','/solutions')))),
    h('section', { className:'sec alt' }, h('div', { className:'wrap' },
      h('div', { className:'sec-head' }, h('h2',null,'What do you need?'), h('p',null,'Isola works whether or not you ever want an assistant.')),
      h('div', { className:'choice' },
        choice('A','I only need phone or communication services','Buy and use a line, PBX or personal number — no assistant required.','/communications'),
        choice('B','I already have service and want an assistant','Add a receptionist or sales assistant to what you already run.','/assistants'),
        choice('C','I want a complete solution','Get communications and an assistant set up together.','/solutions')))),
    h(Footer, { go }));
}

function CommunicationsCatalogue({ go }) {
  useEffect(()=>{ A.emit('page_view', { route:'/communications' }); },[]);
  const keys = ['business_line','hosted_pbx','connect_pbx','personal_line'];
  return h('div', null,
    h(Hero, { eyebrow:'Communications services', title:'Numbers and calling that work on their own.',
      sub:'Every service here is usable without an assistant. Add one later if it helps.', go }),
    h('section', { className:'sec' }, h('div', { className:'wrap' }, h('div', { className:'grid g2' },
      keys.map(k=>{ const p=PRODUCTS[k]; return h('div',{key:k,className:'card card-pad',onClick:()=>go(p.route),style:{cursor:'pointer'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'flex-start'}},
          h('h3',null,p.eyebrow.split('· ')[1]), h(Readiness,{state:p.isola})),
        h('p',{className:'kd'},p.sub),
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:16}},
          h('span',{className:'price',style:{fontSize:20}},p.price.label,p.price.unit?h('span',null,p.price.unit):null),
          h('span',{style:{color:'var(--primary)',fontWeight:600,fontSize:14,display:'flex',gap:6,alignItems:'center'}},'View ',h(Arrow,{width:15,height:15})))); })))),
    h(Footer, { go }));
}

function AssistantCatalogue({ go }) {
  useEffect(()=>{ A.emit('page_view', { route:'/assistants' }); },[]);
  return h('div', null,
    h(Hero, { eyebrow:'Digital assistants', title:'Add a teammate to the tools you already use.',
      sub:'Give an assistant a familiar job — reception, sales, booking, support — on your approved WhatsApp channel. A person is always one tap away.', go }),
    h('section', { className:'sec' }, h('div', { className:'wrap' }, h('div', { className:'grid g3' },
      ASSISTANTS.map(a=>h(AssistantCard,{key:a.id,a}))))),
    h(Footer, { go }));
}
function AssistantCard({ a }) {
  const [state, run] = useCta();
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  return h('div', { className:'card card-pad' },
    h('div',{style:{display:'flex',justifyContent:'space-between',gap:8,alignItems:'flex-start'}}, h('h3',null,a.title), h(Readiness,{state:a.state})),
    h('div',{className:'muted',style:{fontSize:13,marginTop:4}},a.job),
    h('ul',{className:'feat'},a.outcomes.slice(0,4).map((t,i)=>h('li',{key:i},h(Check,{width:15,height:15}),t))),
    h('div',{className:'tags'}, a.works.map(w=>h('span',{key:w,className:'tg'},w))),
    h('div',{className:'subcard'},
      h('input',{value:contact,onChange:e=>setContact(e.target.value),placeholder:'WhatsApp number or email',
        style:{width:'100%',padding:'7px 9px',borderRadius:8,border:'1px solid var(--input)',fontSize:13,fontFamily:'inherit',background:'var(--background)',color:'var(--foreground)'}}),
      h('label',{style:{display:'flex',gap:7,alignItems:'flex-start',fontSize:12,marginTop:8,cursor:'pointer',color:'var(--muted-foreground)'}},
        h('input',{type:'checkbox',checked:consent,onChange:e=>setConsent(e.target.checked),style:{marginTop:2}}),'EPIC may contact me about this assistant.')),
    h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}},
      h('span',{className:'price',style:{fontSize:18}},a.price.label,a.price.unit?h('span',null,a.price.unit):null),
      h('button',{className:'btn btn-default btn-sm',disabled:state.phase==='loading',onClick:()=>run(a.cta,{consent,contact})}, state.phase==='loading'?h('span',{className:'spin'}):h(Spark,{width:15,height:15}),'Enquire')),
    state.phase==='validation'?h('div',{className:'state state-warn',style:{marginTop:10}},h(Ic,{d:'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'}),state.msg):null,
    state.phase==='success'?h('div',{className:'state state-ok',style:{marginTop:10}},h(Check),'Request received — EPIC will confirm scope, channels and permissions.'):null,
    state.phase==='error'?h('div',{className:'state state-err',style:{marginTop:10}},h(X),'Could not submit — ',h('a',{href:WA,target:'_blank',style:{textDecoration:'underline'}},'message EPIC')):null);
}

function SolutionsCatalogue({ go }) {
  useEffect(()=>{ A.emit('page_view', { route:'/solutions' }); },[]);
  const sol = [
    { k:'smart_front_desk', name:'Smart Front Desk', combo:'Business Line + Business Receptionist + shared inbox', go:PRODUCTS.smart_front_desk.route },
    { name:'Smart Office Phone System', combo:'Hosted PBX + staff extensions + Business Receptionist', state:'Conditional', to:'/hosted-pbx' },
    { name:'WhatsApp Sales Desk', combo:'WhatsApp + Sales Assistant + CRM follow-up', state:'Conditional', to:'/assistants' },
    { name:'Customer Support Desk', combo:'WhatsApp + Support Assistant + human escalation', state:'Conditional', to:'/assistants' },
    { name:'Personal Line+', combo:'Personal Line + EPIC Assistant (where verified)', state:'Conditional', to:'/personal-line' },
  ];
  return h('div', null,
    h(Hero, { eyebrow:'Complete solutions', title:'Communications and an assistant, packaged.',
      sub:'When you want the whole thing set up together. Not every business needs a complete solution — start smaller any time.', go }),
    h('section', { className:'sec' }, h('div', { className:'wrap' }, h('div', { className:'grid g2' },
      sol.map((s,i)=>h('div',{key:i,className:'card card-pad',style:{cursor:'pointer'},onClick:()=>go(s.go||s.to)},
        h('div',{style:{display:'flex',justifyContent:'space-between',gap:10,alignItems:'flex-start'}},
          h('h3',null,s.name), h(Readiness,{state:s.k?PRODUCTS.smart_front_desk.isola:s.state})),
        h('p',{className:'kd'},s.combo),
        s.k?h('div',{style:{marginTop:14}},h('span',{className:'price',style:{fontSize:20}},PRICE.sfd.label,h('span',null,PRICE.sfd.unit))):h('div',{className:'muted',style:{marginTop:14,fontSize:13}},'Contact EPIC'),
        h('div',{style:{marginTop:10,color:'var(--primary)',fontWeight:600,fontSize:14,display:'flex',gap:6,alignItems:'center'}},'View ',h(Arrow,{width:15,height:15}))))))),
    h(Footer, { go }));
}

/* ================= router ================= */
const PAGE_FOR = {
  '/products':(go)=>h(PortfolioHome,{go}),
  '/communications':(go)=>h(CommunicationsCatalogue,{go}),
  '/assistants':(go)=>h(AssistantCatalogue,{go}),
  '/solutions':(go)=>h(SolutionsCatalogue,{go}),
  '/business-line':(go,fs)=>h(ProductPage,{pkey:'business_line',go,forceState:fs}),
  '/hosted-pbx':(go,fs)=>h(ProductPage,{pkey:'hosted_pbx',go,forceState:fs}),
  '/connect-pbx':(go,fs)=>h(ProductPage,{pkey:'connect_pbx',go,forceState:fs}),
  '/personal-line':(go,fs)=>h(ProductPage,{pkey:'personal_line',go,forceState:fs}),
  '/solutions/smart-front-desk':(go,fs)=>h(ProductPage,{pkey:'smart_front_desk',go,forceState:fs}),
};

function App() {
  const [path, setPath] = useState(location.hash.slice(1) || '/products');
  const [device, setDevice] = useState('desktop');
  const [force, setForce] = useState('live');
  const go = useCallback((p)=>{ setPath(p); location.hash = p; const sb=document.querySelector('.scrollbox'); if(sb)sb.scrollTop=0; window.scrollTo(0,0); },[]);
  useEffect(()=>{ const on=()=>setPath(location.hash.slice(1)||'/products'); addEventListener('hashchange',on); return ()=>removeEventListener('hashchange',on); },[]);
  const render = PAGE_FOR[path] || PAGE_FOR['/products'];
  const isProduct = /business-line|hosted-pbx|connect-pbx|personal-line|smart-front-desk/.test(path);
  const inner = h('div', { className:'viewport'+(device==='mobile'?' narrow':'') },
    h(Nav, { go, path }),
    device==='mobile' ? h('div',{className:'scrollbox'}, render(go, force)) : render(go, force));
  return h('div', null,
    h('div', { className:'shell' },
      h('b', null, 'FOH Stage 1 · route:'), h('code',{style:{color:'#8fe',fontFamily:'monospace'}}, path),
      h('span', { className:'seg' }, h('button',{className:device==='desktop'?'on':'',onClick:()=>setDevice('desktop')},'Desktop'), h('button',{className:device==='mobile'?'on':'',onClick:()=>setDevice('mobile')},'Mobile')),
      isProduct ? h('label', { style:{display:'flex',gap:6,alignItems:'center'} }, 'Preview state:',
        h('select', { value:force, onChange:e=>setForce(e.target.value) },
          ['live','loading','validation','service_error','recovery'].map(s=>h('option',{key:s,value:s},s)))) : null,
      h('span', { className:'spacer' }),
      h('span', { className:'note' }, device==='mobile'?'390px viewport simulation — layout is genuinely responsive (same CSS breakpoints)':'Responsive layout · real breakpoints at 860px')),
    h('div', { className:'stage '+device }, inner));
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
