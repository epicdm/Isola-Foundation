import { getMagnusConfig } from '../lib/engines'
import { getBalance } from '../engines/magnus'
import { readDidDestination } from '../lib/magnus-voice'
const cfg=getMagnusConfig()
;(async()=>{
  console.log('MAGNUS_balance_1562 ' + JSON.stringify(await getBalance(cfg,'1562')))
  console.log('MAGNUS_route_2605 ' + JSON.stringify(await readDidDestination(cfg,'2605')))
  process.exit(0)
})().catch(e=>{console.error('ERR '+(e?.message||e));process.exit(1)})
