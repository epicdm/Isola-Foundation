'use client';

import { useState } from 'react';
import { AlertTriangle, Bell, Building2, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TENANT } from '../../_lib/mock-data';

export default function SettingsPage() {
  const [notifyMissedCalls, setNotifyMissedCalls] = useState(true);
  const [notifyHandoff, setNotifyHandoff] = useState(true);
  const [notifyBilling, setNotifyBilling] = useState(false);

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Business profile, notifications, and account controls.</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4 text-primary" /> Business profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-name">Business name</Label>
                <Input id="settings-name" defaultValue={TENANT.name} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-address">Address</Label>
                <Input id="settings-address" defaultValue={TENANT.address} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-tz">Timezone</Label>
                <Select defaultValue={TENANT.timezone}>
                  <SelectTrigger id="settings-tz">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/Dominica">America/Dominica</SelectItem>
                    <SelectItem value="America/New_York">America/New_York</SelectItem>
                    <SelectItem value="UTC">UTC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm">Save changes (mock)</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bell className="size-4 text-primary" /> Notification preferences
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-semibold">Missed call alerts</Label>
                  <p className="text-xs text-muted-foreground">Notify me by WhatsApp when a call is missed.</p>
                </div>
                <Switch checked={notifyMissedCalls} onCheckedChange={setNotifyMissedCalls} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-semibold">Human takeover requests</Label>
                  <p className="text-xs text-muted-foreground">Notify me when the AI escalates a conversation.</p>
                </div>
                <Switch checked={notifyHandoff} onCheckedChange={setNotifyHandoff} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-semibold">Billing receipts</Label>
                  <p className="text-xs text-muted-foreground">Email a receipt for every wallet top-up.</p>
                </div>
                <Switch checked={notifyBilling} onCheckedChange={setNotifyBilling} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="mt-4">
          <Card className="border-destructive/25">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <AlertTriangle className="size-4" /> Danger zone
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-sm font-semibold">Cancel service</div>
                <p className="text-xs text-muted-foreground">
                  Stops billing at the end of the current period. Channels remain connected until teardown.
                </p>
              </div>
              <div>
                <div className="text-sm font-semibold">Tear down tenant</div>
                <p className="text-xs text-muted-foreground">
                  Disconnects all channels and removes this business from Isola. This cannot be undone.
                </p>
              </div>
              <Button variant="destructive" size="sm" disabled>
                <Clock className="size-3.5" /> Request cancellation (mock, disabled)
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
