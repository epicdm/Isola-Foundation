// scripts/provision-gold-demo.ts — invoke the validated provisioning fn (reuse, not raw)
import { provisionTenantVoice } from '../lib/voice-provisioning'
const id = process.argv[2]
if (!id) { console.error('need tenant id'); process.exit(2) }
provisionTenantVoice(id)
  .then(r => { console.log('RESULT ' + JSON.stringify(r)); process.exit(0) })
  .catch(e => { console.error('ERR ' + (e?.message || e)); process.exit(1) })
