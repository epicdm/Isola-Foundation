p = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/app/lib/wa-send-gate.ts'
s = open(p, encoding='utf-8').read()
old1 = "      if (ctx.kind === 'template' || ctx.kind === 'flow') {\n        return await checkTemplatePolicyAndDecide(ctx, phone, userId, 'allow_owner_alert', optIn?.id, idempotencyKey)"
assert s.count(old1) == 1
s = s.replace(old1, "      // A proven PL reply (isPlVerifiedInboundReply) is a same-thread reply, not an owner alert: it skips the template-policy branch.\n      if ((ctx.kind === 'template' || ctx.kind === 'flow') && !isPlVerifiedInboundReply(ctx)) {\n        return await checkTemplatePolicyAndDecide(ctx, phone, userId, 'allow_owner_alert', optIn?.id, idempotencyKey)", 1)
old2 = "        const windowValid = await isWithinServiceWindow(userId, phone)\n        if (windowValid) {"
assert s.count(old2) == 1
s = s.replace(old2, "        // The verified PL assertion proves the inbound message inside the window (it lives in Chatwoot since the 0001 cutover).\n        const windowValid = isPlVerifiedInboundReply(ctx) || await isWithinServiceWindow(userId, phone)\n        if (windowValid) {", 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched rc10i')
