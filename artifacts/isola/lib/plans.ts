/**
 * Isola subscription plan definitions.
 * Kept in a shared lib so it can be imported by both API routes and UI pages
 * without violating Next.js route export restrictions.
 */
export const PLAN_PRICES: Record<string, { price: number; label: string; features: string[] }> = {
  starter: {
    price: 39,
    label: 'Starter',
    features: ['AI Agent', 'WhatsApp inbox', '500 AI turns/mo', '100 call minutes/mo'],
  },
  growth: {
    price: 89,
    label: 'Growth',
    features: ['Everything in Starter', '2,000 AI turns/mo', '500 call minutes/mo', 'CRM integration'],
  },
  pro: {
    price: 179,
    label: 'Pro',
    features: ['Everything in Growth', 'Unlimited AI turns', '2,000 call minutes/mo', 'Priority support'],
  },
};
