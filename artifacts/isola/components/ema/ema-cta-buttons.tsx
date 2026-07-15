'use client';

import { ArrowRight, MessageCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { trackEmaCta, type EmaUtmParams } from './ema-landing-client';

export function EmaCtaButtons({
  signupUrl,
  whatsappUrl,
  utm,
  landingPath,
  size = 'lg',
}: {
  signupUrl: string;
  whatsappUrl: string;
  utm: EmaUtmParams;
  landingPath: string;
  size?: 'default' | 'lg';
}) {
  return (
    <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
      <Button asChild size={size} className="w-full sm:w-auto">
        <a href={signupUrl} onClick={() => trackEmaCta('signup', utm, landingPath)}>
          Get your number <ArrowRight className="size-4" />
        </a>
      </Button>
      <Button asChild size={size} variant="outline" className="w-full sm:w-auto">
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEmaCta('whatsapp', utm, landingPath)}
        >
          <MessageCircle className="size-4" /> Chat on WhatsApp
        </a>
      </Button>
    </div>
  );
}
