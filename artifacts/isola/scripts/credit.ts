import { getMagnusConfig } from '../lib/engines'
import { getBalance, addCredit } from '../engines/magnus'
const cfg = getMagnusConfig()
const uid = process.argv[2]; const amt = parseFloat(process.argv[3] || '20')
;(async()=>{
  console.log('BEFORE ' + JSON.stringify(await getBalance(cfg, uid)))
  const r = await addCredit(cfg, uid, amt, 'Isola gold demo credit')
  console.log('ADD ' + JSON.stringify(r))
  console.log('AFTER ' + JSON.stringify(await getBalance(cfg, uid)))
  process.exit(0)
})().catch(e=>{ console.error('ERR '+(e?.message||e)); process.exit(1) })
