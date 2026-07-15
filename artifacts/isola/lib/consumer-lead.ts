/**
 * lib/consumer-lead.ts — P6 EMA landing page funnel attribution.
 *
 * Local ConsumerLead row is always the source of truth (written first,
 * unconditionally). If Odoo is configured AND reachable, we additionally
 * mirror the lead into Odoo's real CRM (crm.lead) with UTM records resolved
 * via engines/odoo.ts, and store the returned odoo_lead_id back on our row.
 * Odoo failure is never fatal to lead capture — this module never fabricates
 * a "recorded in Odoo" result when the call didn't actually happen/succeed.
 */

import { prisma } from './prisma';
import { getOdooConfig, isOdooConfigured } from './engines';
import { createCrmLead } from '@/engines/odoo';

export interface CaptureLeadInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  cta?: string | null;
}

export interface CaptureLeadResult {
  ok: true;
  leadId: string;
  odooLeadId: number | null;
}

export async function captureConsumerLead(input: CaptureLeadInput): Promise<CaptureLeadResult> {
  const lead = await prisma.consumerLead.create({
    data: {
      utm_source: input.utmSource || null,
      utm_medium: input.utmMedium || null,
      utm_campaign: input.utmCampaign || null,
      utm_term: input.utmTerm || null,
      utm_content: input.utmContent || null,
      referrer: input.referrer || null,
      landing_path: input.landingPath || null,
      cta: input.cta || null,
    },
  });

  let odooLeadId: number | null = null;
  if (isOdooConfigured()) {
    try {
      const config = getOdooConfig();
      odooLeadId = await createCrmLead(config, {
        name: `EMA landing page — ${input.cta || 'visit'}`,
        utmSource: input.utmSource || undefined,
        utmMedium: input.utmMedium || undefined,
        utmCampaign: input.utmCampaign || undefined,
        description: [
          input.landingPath ? `landing_path=${input.landingPath}` : null,
          input.referrer ? `referrer=${input.referrer}` : null,
          input.utmTerm ? `utm_term=${input.utmTerm}` : null,
          input.utmContent ? `utm_content=${input.utmContent}` : null,
        ]
          .filter(Boolean)
          .join('; '),
      });
      if (odooLeadId) {
        await prisma.consumerLead.update({
          where: { id: lead.id },
          data: { odoo_lead_id: odooLeadId },
        });
      }
    } catch (err) {
      console.error('[consumer-lead] Odoo mirror failed (local record kept regardless):', err);
    }
  }

  return { ok: true, leadId: lead.id, odooLeadId };
}
