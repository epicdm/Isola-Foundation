'use client';

import { useState, useEffect } from 'react';
import { Bot, BookOpen, Zap, Clock, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Alert } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const TIERS = [
  { value: 'standard', label: 'Standard — Claude Haiku',   desc: 'Fastest replies, lowest cost (~$0.80/M tokens)' },
  { value: 'advanced', label: 'Advanced — Claude Sonnet',  desc: 'Balanced quality and speed (~$3/M tokens)' },
  { value: 'expert',   label: 'Expert — Claude Opus',      desc: 'Highest capability, best for complex queries (~$15/M tokens)' },
];

const TIMEZONES = [
  'America/Dominica',
  'America/Barbados',
  'America/St_Kitts',
  'America/Grenada',
  'America/St_Vincent',
  'America/Antigua',
  'America/St_Lucia',
  'America/Port_of_Spain',
  'America/New_York',
  'UTC',
];

export default function AgentPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    greeting: '',
    business_info: '',
    knowledge_text: '',
    intelligence_tier: 'standard',
    after_hours_start: '',
    after_hours_end: '',
    timezone: 'America/Dominica',
    is_active: true,
  });

  useEffect(() => {
    fetch('/api/agent/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d.agent) setForm({ ...d.agent });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const val = key === 'is_active' ? (e.target as HTMLInputElement).checked : e.target.value;
      setForm((f) => ({ ...f, [key]: val }));
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(''); setSaved(false);
    try {
      const res = await fetch('/api/agent/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Failed'); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center p-10">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">AI Agent</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure how your AI agent talks and what it knows.</p>
      </div>

      <form onSubmit={handleSave} className="max-w-2xl space-y-5">
        {error && (
          <Alert variant="destructive">{error}</Alert>
        )}
        {saved && (
          <Alert className="border-success/30 bg-success/10 text-success">
            <CheckCircle2 className="size-4" /> Settings saved.
          </Alert>
        )}

        {/* Identity */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-primary" />
              Identity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Agent name</Label>
              <Input
                id="agent-name"
                value={form.name}
                onChange={set('name')}
                placeholder="Isola Assistant"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="greeting">Greeting style</Label>
              <Input
                id="greeting"
                value={form.greeting}
                onChange={set('greeting')}
                placeholder="Hello! How can I help you today?"
              />
              <p className="text-xs text-muted-foreground">Opening line or style guide for every new conversation.</p>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Switch
                id="is_active"
                checked={form.is_active}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, is_active: checked }))}
              />
              <div>
                <Label htmlFor="is_active" className="text-sm font-semibold cursor-pointer">Agent active</Label>
                <p className="text-xs text-muted-foreground">Uncheck to pause the AI without clearing settings.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Knowledge */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4 text-primary" />
              Knowledge
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="business_info">Business info</Label>
              <Textarea
                id="business_info"
                value={form.business_info}
                onChange={set('business_info')}
                placeholder="Describe your business: what you sell, your location, opening hours, pricing…"
                className="min-h-[100px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="knowledge_text">Knowledge base</Label>
              <Textarea
                id="knowledge_text"
                value={form.knowledge_text}
                onChange={set('knowledge_text')}
                placeholder="FAQs, product specs, policies, common questions and answers…"
                className="min-h-[180px]"
              />
              <p className="text-xs text-muted-foreground">Paste anything the agent should know: FAQ, menus, policies.</p>
            </div>
          </CardContent>
        </Card>

        {/* Intelligence tier */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" />
              Intelligence tier
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2.5">
              {TIERS.map((t) => (
                <label
                  key={t.value}
                  className={cn(
                    'flex gap-3 items-start cursor-pointer rounded-lg border p-3.5 transition-colors',
                    form.intelligence_tier === t.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/40'
                  )}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={t.value}
                    checked={form.intelligence_tier === t.value}
                    onChange={() => setForm((f) => ({ ...f, intelligence_tier: t.value }))}
                    className="mt-0.5 accent-primary"
                  />
                  <div>
                    <div className="text-sm font-semibold">{t.label}</div>
                    <div className="text-xs text-muted-foreground">{t.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* After-hours silence */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-primary" />
              After-hours silence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Set a window when the AI does not reply (messages still mirror to Chatwoot).
              Leave blank to reply 24/7.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="after_hours_start">Silent from</Label>
                <Input
                  id="after_hours_start"
                  type="time"
                  value={form.after_hours_start ?? ''}
                  onChange={set('after_hours_start')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="after_hours_end">Until</Label>
                <Input
                  id="after_hours_end"
                  type="time"
                  value={form.after_hours_end ?? ''}
                  onChange={set('after_hours_end')}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Select value={form.timezone} onValueChange={(val) => setForm((f) => ({ ...f, timezone: val }))}>
                <SelectTrigger id="timezone">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </form>
    </>
  );
}
