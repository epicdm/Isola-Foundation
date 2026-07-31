const URL_ = process.env.ISOLA_BRIDGE_URL || 'https://agents.epic.dm/api/isola/bridge/message'

async function call(label: string, body: Record<string, unknown>) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Isola-Secret': String(process.env.CLAWITH_SHARED_SECRET),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  console.log(`${label} -> HTTP ${res.status}`)
  console.log(`   body: ${text.slice(0, 500)}`)
  return res.status
}

async function main() {
  const agent = String(process.env.CLAWITH_INTERNAL_STAFF_AGENT_ID)
  console.log(`agent ${agent.slice(0, 8)}... url ${URL_}`)

  // A: bare minimum the live model requires.
  await call('A minimal', {
    agent_id: agent,
    phone: '15550000000',
    text: 'Foundation acceptance probe. Reply with the word ONLINE.',
  })

  // B: same, plus correlation + external conversation id.
  await call('B with ids', {
    agent_id: agent,
    phone: '15550000000',
    text: 'Foundation acceptance probe. Reply with the word ONLINE.',
    correlation_id: 'probe-b',
    external_conversation_id: 'probe-session-b',
  })

  // C: control - the known-good customer agent, to tell "Atlas is broken"
  // apart from "the bridge is broken".
  const ema = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162'
  await call('C control EMA', {
    agent_id: ema,
    phone: '15550000001',
    text: 'ping',
    correlation_id: 'probe-c',
  })
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e?.message ?? e)
    process.exit(1)
  })
