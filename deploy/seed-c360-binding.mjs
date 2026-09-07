/**
 * Re-create the ONE ChatwootBinding + Conversation mirror row for the
 * real Customer 360 UAT conversation (acct 2 / inbox 7 / conv display_id 15),
 * scoped to the CURRENT logged-in tenant. Idempotent: upserts, does not
 * duplicate on re-run. Real inputs, synthetic store -- same pattern already
 * evidenced for this feature. Writes NOTHING to production Chatwoot or Odoo.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  const pw = readFileSync('/run/secrets/db_password', 'utf8').trim();
  process.env.DATABASE_URL =
    `postgresql://${process.env.DB_USER || 'isola360'}:${pw}` +
    `@${process.env.DB_HOST || 'db'}:5432/${process.env.DB_NAME || 'isola360uat'}`;
}

const TENANT_ID = process.argv[2];
if (!TENANT_ID) {
  console.error('usage: node seed-c360-binding.mjs <tenant_id>');
  process.exit(1);
}

const prisma = new PrismaClient();

const tenant = await prisma.tenant.findUnique({ where: { id: TENANT_ID } });
if (!tenant) {
  console.error(`FATAL: no tenant row for id ${TENANT_ID}`);
  process.exit(1);
}
console.log(`tenant confirmed: id=${tenant.id}`);

const existingBinding = await prisma.chatwootBinding.findFirst({
  where: { tenant_id: TENANT_ID, account_id: '2', inbox_id: '7' },
});
let binding;
if (existingBinding) {
  binding = existingBinding;
  console.log('ChatwootBinding already present, no write');
} else {
  binding = await prisma.chatwootBinding.create({
    data: {
      tenant_id: TENANT_ID,
      base_url: 'https://inbox.epic.dm',
      account_id: '2',
      inbox_id: '7',
      token: '',
      mode: 'mirror',
    },
  });
  console.log(`ChatwootBinding CREATED id=${binding.id}`);
}

const existingConv = await prisma.conversation.findFirst({
  where: { tenant_id: TENANT_ID, chatwoot_conversation_id: 15 },
});
let conv;
if (existingConv) {
  conv = existingConv;
  console.log('Conversation mirror already present, no write');
} else {
  conv = await prisma.conversation.create({
    data: {
      tenant_id: TENANT_ID,
      chatwoot_conversation_id: 15,
      customer_phone: '+17672951770',
      customer_name: 'Yvonne Armour',
      status: 'pending',
    },
  });
  console.log(`Conversation CREATED id=${conv.id}`);
}

const existingMsg = await prisma.message.findFirst({ where: { conversation_id: conv.id } });
if (!existingMsg) {
  await prisma.message.create({
    data: {
      conversation_id: conv.id,
      role: 'user',
      content: 'Support request carried from the EPIC front desk (Customer 360 panel context).',
    },
  });
  console.log('seed Message created');
} else {
  console.log('Message already present, no write');
}

console.log('DONE -- binding.id=' + binding.id + ' conversation.id=' + conv.id);
await prisma.$disconnect();
