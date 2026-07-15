import { getMagnusConfig } from '../lib/engines'
import * as mv from '../lib/magnus-voice'
const cfg = getMagnusConfig()
;(async()=>{
  console.log('exports:', Object.keys(mv).filter(k=>/user|sip|balance|credit|read|refill/i.test(k)).join(','))
  try { const sip = await (mv as any).readSipAccount(cfg, '1833'); console.log('SIP1833 ' + JSON.stringify(sip)) } catch(e:any){ console.log('sip read err '+e?.message) }
  // try to read the magnus user (credit/balance)
  for (const fn of ['readUserById','getMagnusUserById','readUser','getUser']) {
    if ((mv as any)[fn]) { try { console.log(fn+' ' + JSON.stringify(await (mv as any)[fn](cfg,'1562'))) } catch(e:any){ console.log(fn+' err '+e?.message) } }
  }
})().catch(e=>{console.error('ERR '+(e?.message||e));process.exit(1)})
