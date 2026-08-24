import { redactSecretValuesForLogs, SECRET_LOG_REPLACEMENT } from "./log-redaction.js";
const D = "planted-dummy-value-4e7a91";
let p=0,f=0; const ok=(n,c)=>{c?(p++,console.log("  PASS  "+n)):(f++,console.log("  FAIL  "+n));};
const J = (x)=>JSON.stringify(x);

console.log("== the secrets request body: value redacted, identifiers kept ==");
const body = { name:"My Secret", key:"RUNTIME_SECRET", value:D, description:"a description" };
const r = redactSecretValuesForLogs(body);
ok("value is redacted", r.value === SECRET_LOG_REPLACEMENT);
ok("value string absent entirely", !J(r).includes(D));
ok("key NAME preserved (needed to debug)", r.key === "RUNTIME_SECRET");
ok("name preserved", r.name === "My Secret");
ok("description preserved", r.description === "a description");

console.log("== other credential field names ==");
for (const k of ["password","token","accessToken","apiKey","api_key","authorization","clientSecret","privateKey","secret"]) {
  const o = redactSecretValuesForLogs({ [k]: D });
  ok(k+" redacted", o[k]===SECRET_LOG_REPLACEMENT && !J(o).includes(D));
}

console.log("== nested and array shapes ==");
ok("nested object", !J(redactSecretValuesForLogs({a:{b:{value:D}}})).includes(D));
ok("inside array", !J(redactSecretValuesForLogs({items:[{value:D},{value:D}]})).includes(D));
ok("array root", !J(redactSecretValuesForLogs([{value:D}])).includes(D));

console.log("== safe data is NOT destroyed (an unreadable log is its own outage) ==");
const safe = { companyId:"3ed3869b", routePath:"/companies/:companyId/secrets", status:409, error:"Secret already exists", count:3, ok:false, nested:{ id:"abc" } };
const rs = redactSecretValuesForLogs(safe);
ok("companyId kept", rs.companyId==="3ed3869b");
ok("routePath kept", rs.routePath==="/companies/:companyId/secrets");
ok("status kept", rs.status===409);
ok("error classification kept", rs.error==="Secret already exists");
ok("numbers/booleans kept", rs.count===3 && rs.ok===false);
ok("nested non-secret kept", rs.nested.id==="abc");

console.log("== robustness ==");
ok("null/undefined pass through", redactSecretValuesForLogs(null)===null && redactSecretValuesForLogs(undefined)===undefined);
ok("plain string passes through", redactSecretValuesForLogs("hello")==="hello");
{ const deep = (n)=> n===0 ? {value:D} : {a:deep(n-1)};
  ok("depth-limited, still redacts and terminates", !J(redactSecretValuesForLogs(deep(20))).includes(D)); }
{ const cyc={}; cyc.self=cyc; cyc.value=D;
  let threw=false; let out=null;
  try{ out=redactSecretValuesForLogs(cyc); }catch{ threw=true; }
  ok("cyclic body does not hang or throw", threw===false && !J(out).includes(D)); }
ok("case-insensitive key match", redactSecretValuesForLogs({VALUE:D}).VALUE===SECRET_LOG_REPLACEMENT);

console.log("");
console.log("  CONTROL: the dummy is findable in a string containing it: " + (("x "+D).includes(D)?"PASS":"FAIL — absence checks void"));
console.log("");
console.log(`RESULT ${p} passed, ${f} failed`);
process.exit(f===0?0:1);
