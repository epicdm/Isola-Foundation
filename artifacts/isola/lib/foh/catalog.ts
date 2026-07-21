// FOH catalog — grounded in Port + claim-guard.ts. EC$ amounts limited to the
// ratified set {750, 375, 249, 250, 99, 149} and EC$0.27/min. Anything else => "Contact EPIC".
export type Readiness = 'Live' | 'Assisted' | 'Conditional' | 'Planned' | 'Not offered';
export interface Price { label: string; unit?: string; note: string }

export const PRICE: Record<string, Price> = {
  contact: { label: 'Contact EPIC', note: 'Pricing confirmed by EPIC before any work begins.' },
  sfd: { label: 'EC$750', unit: ' setup', note: 'Two EC$375 installments — before work, then at acceptance · EC$249/mo · voice balance separate.' },
  war: { label: 'EC$250', unit: ' setup', note: 'EC$149/mo · no new voice line or PBX included.' },
  pbxup: { label: 'EC$250', unit: ' setup', note: 'EC$99/mo · existing voice charges separate.' },
  personal: { label: 'EC$0.27', unit: '/min', note: 'Prepaid wallet · calling billed per minute.' },
};

export interface Product {
  key: string; route: string; kind: string; eyebrow: string; title: string; sub: string;
  engine: Readiness; isola: Readiness; price: Price;
  included: string[]; optional: string[]; exclusions: string[];
  primary: string; secondary: string;
}

export const PRODUCTS: Record<string, Product> = {
  business_line: { key:'business_line', route:'/business-line', kind:'Communications service', eyebrow:'Communications · Business Line',
    title:'A business line that answers — even when you can’t.',
    sub:'A business WhatsApp number and supported calling for your team, set up and managed by EPIC. No assistant required.',
    engine:'Live', isola:'Assisted', price:PRICE.contact,
    included:['Business WhatsApp and supported calling configuration','One or more approved SIP accounts','Acrobits or endpoint access','Optional PSTN DID','Prepaid calling wallet','Voicemail, forwarding and approved fallback'],
    optional:['Add a Business Receptionist assistant (optional)','Upgrade to a complete Smart Front Desk'],
    exclusions:['No assistant is required to use this service','WhatsApp inbound calling is conditional where number and route verification are required'],
    primary:'cta_business_line', secondary:'cta_talk_sales_assistant' },
  hosted_pbx: { key:'hosted_pbx', route:'/hosted-pbx', kind:'Communications service', eyebrow:'Communications · Hosted PBX',
    title:'A complete phone system for your team.',
    sub:'Extensions, aliases, IVR, queues, voicemail and routing on EPIC’s mature hosted PBX — usable without any assistant.',
    engine:'Live', isola:'Conditional', price:PRICE.contact,
    included:['SIP users and endpoints','Four-digit internal aliases','IVR, queues or ring groups','Voicemail, hours and routing','Optional DIDs','Ordinary inbound and outbound calling','Balances and CDRs'],
    optional:['Add a Business Receptionist','Add a Sales Assistant','Add a Support Assistant'],
    exclusions:['The packaged Isola experience is Conditional until governed provisioning and end-to-end acceptance are proven','No assistant is bundled unless you choose an assistant-inclusive package'],
    primary:'cta_hosted_pbx', secondary:'cta_request_demo' },
  connect_pbx: { key:'connect_pbx', route:'/connect-pbx', kind:'Communications service', eyebrow:'Communications · Connect Existing PBX',
    title:'Keep your PBX. Add WhatsApp calling.',
    sub:'Route inbound WhatsApp calls and optional EPIC voice into the PBX, SBC or SIP trunk you already run.',
    engine:'Live', isola:'Conditional', price:PRICE.contact,
    included:['WhatsApp inbound calling into your existing PBX/SBC/SIP trunk','Customer-specific route test','Optional EPIC DID','CDR visibility','Failover configuration','Guided integration by EPIC'],
    optional:['Add an Isola Receptionist','Add a Support Assistant'],
    exclusions:['AI reception is optional, not required','The customer-specific route is Conditional until it passes the approved route acceptance test'],
    primary:'cta_connect_pbx', secondary:'cta_talk_sales_assistant' },
  personal_line: { key:'personal_line', route:'/personal-line', kind:'Communications service', eyebrow:'Communications · Personal Line',
    title:'Your own Dominica line for calling home.',
    sub:'A personal Dominica number with a prepaid wallet and app calling. Usable on its own — no assistant to activate.',
    engine:'Live', isola:'Conditional', price:PRICE.personal,
    included:['Personal Dominica number','Progressive web app (PWA)','Acrobits softphone','Prepaid wallet and top-ups','Calling plans or bundles','Usage and balance','Support'],
    optional:['EPIC Assistant available where verified (optional support benefit)','Personal Assistant / Personal AI+ (Planned)'],
    exclusions:['You are never required to activate or interact with an assistant','Personal AI+ is Planned — pricing, metering and spending controls unresolved'],
    primary:'cta_personal_line', secondary:'cta_contact_support' },
  smart_front_desk: { key:'smart_front_desk', route:'/solutions/smart-front-desk', kind:'Complete solution', eyebrow:'Complete solution · Smart Front Desk',
    title:'A front desk that never misses a customer.',
    sub:'Business Line + a Business Receptionist + shared inbox + supported calling, set up and managed by EPIC end to end.',
    engine:'Live', isola:'Assisted', price:PRICE.sfd,
    included:['Business Line (WhatsApp + supported calling)','Business Receptionist assistant','Shared inbox with human takeover','Supported calling configuration','Human escalation'],
    optional:['Add extra assistants (Sales, Support) later','Grow into a Hosted PBX'],
    exclusions:['Voice balance is billed separately','Delivered as a managed, assisted setup — not instant self-service'],
    primary:'cta_build_smart_front_desk', secondary:'cta_request_demo' },
};

export interface Assistant { id: string; title: string; job: string; state: Readiness; price: Price; cta: string; outcomes: string[]; channels: string[]; works: string[] }
export const ASSISTANTS: Assistant[] = [
  { id:'business_receptionist', title:'Business Receptionist', job:'Greets and routes every WhatsApp enquiry', state:'Assisted', price:PRICE.war, cta:'cta_add_receptionist', outcomes:['Approved WhatsApp responses','Lead and enquiry capture','Shared inbox','Human takeover','After-hours assistance'], channels:['WhatsApp'], works:['Business Line','Hosted PBX','Connect Existing PBX'] },
  { id:'sales_assistant', title:'Sales Assistant', job:'Follows up with every enquiry', state:'Conditional', price:PRICE.contact, cta:'cta_add_sales_assistant', outcomes:['Enquiry follow-up','Lead qualification','CRM follow-up notes','Human handoff for offers/pricing'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'support_assistant', title:'Support Assistant', job:'Answers common questions, escalates the rest', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant', outcomes:['Deflects common questions','Human escalation','Shared inbox'], channels:['WhatsApp'], works:['Hosted PBX','Connect Existing PBX'] },
  { id:'booking_assistant', title:'Booking Assistant', job:'Captures and confirms booking requests', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant', outcomes:['Booking capture','Confirmation messaging','Human handoff'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'account_assistant', title:'Account Assistant', job:'Helps customers with their own account', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant', outcomes:['Own-account help','Balance and usage questions','Human escalation'], channels:['WhatsApp'], works:['Business Line','Hosted PBX'] },
  { id:'epic_assistant', title:'EPIC Assistant', job:'Explains EPIC services and helps with your own account', state:'Conditional', price:{label:'Available where verified',note:'Included support benefit on Personal Line where verified.'}, cta:'cta_contact_support', outcomes:['Explains EPIC services','Signup assistance','Own approved account info','Activation and top-up guidance','Escalates to a person'], channels:['WhatsApp'], works:['Personal Line'] },
  { id:'personal_assistant', title:'Personal Assistant', job:'Broader personal assistance', state:'Planned', price:PRICE.contact, cta:'cta_contact_support', outcomes:['Broader approved skills (Planned)','Wallet-funded (Planned)'], channels:['WhatsApp'], works:['Personal Line'] },
  { id:'custom_assistant', title:'Custom Assistant', job:'A scoped assistant for your workflow', state:'Conditional', price:PRICE.contact, cta:'cta_talk_sales_assistant', outcomes:['Scoped approved tools','Defined permissions','Human escalation'], channels:['WhatsApp'], works:['Hosted PBX','Business Line'] },
];

export const WA_URL = 'https://wa.me/17678180001';
