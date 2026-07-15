import { getMagnusConfig } from '../lib/engines'
import { readDidDestination, setDidDestinationRoute } from '../lib/magnus-voice'
const cfg = getMagnusConfig()
const ddid = process.argv[2]; const cell = process.argv[3]
;(async()=>{
  console.log('INIT ' + JSON.stringify(await readDidDestination(cfg, ddid)))
  await setDidDestinationRoute(cfg, ddid, { mode:'cell', cellNumber: cell })
  console.log('AFTER_CELL ' + JSON.stringify(await readDidDestination(cfg, ddid)))
  await setDidDestinationRoute(cfg, ddid, { mode:'sip' })
  console.log('AFTER_SIP ' + JSON.stringify(await readDidDestination(cfg, ddid)))
  process.exit(0)
})().catch(e=>{ console.error('ERR '+(e?.message||e)); process.exit(1) })
