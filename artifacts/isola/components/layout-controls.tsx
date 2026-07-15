'use client';

import { Settings } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ContentLayout, NavbarStyle, SidebarCollapsible, SidebarVariant } from '@/lib/preferences/layout';
import { THEME_PRESET_OPTIONS, type ThemePreset } from '@/lib/preferences/theme';
import { usePreferencesStore } from '@/stores/preferences/preferences-provider';

/** Ported from Studio Admin — the preset/layout preferences popover shown in the topbar. */
export function LayoutControls() {
  const { values, resolvedThemeMode, setPreference, resetPreferences } = usePreferencesStore(
    useShallow((state) => ({
      values: state.values,
      resolvedThemeMode: state.resolvedThemeMode,
      setPreference: state.setPreference,
      resetPreferences: state.resetPreferences,
    })),
  );

  const {
    theme_preset: themePreset,
    content_layout: contentLayout,
    navbar_style: navbarStyle,
    sidebar_variant: variant,
    sidebar_collapsible: collapsible,
  } = values;

  const onThemePresetChange = (preset: ThemePreset) => setPreference('theme_preset', preset);
  const onContentLayoutChange = (layout: ContentLayout | '') => {
    if (layout) setPreference('content_layout', layout);
  };
  const onNavbarStyleChange = (style: NavbarStyle | '') => {
    if (style) setPreference('navbar_style', style);
  };
  const onSidebarStyleChange = (value: SidebarVariant | '') => {
    if (value) setPreference('sidebar_variant', value);
  };
  const onSidebarCollapseModeChange = (value: SidebarCollapsible | '') => {
    if (value) setPreference('sidebar_collapsible', value);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Settings />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <h4 className="font-medium text-sm leading-none">Preferences</h4>
            <p className="text-muted-foreground text-xs">Customize your dashboard layout preferences.</p>
          </div>
          <div className="space-y-3 **:data-[slot=toggle-group]:w-full **:data-[slot=toggle-group-item]:flex-1 **:data-[slot=toggle-group-item]:text-xs">
            <div className="space-y-1">
              <Label className="font-medium text-xs">Theme Preset</Label>
              <Select value={themePreset} onValueChange={onThemePresetChange}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder="Preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {THEME_PRESET_OPTIONS.map((preset) => (
                      <SelectItem key={preset.value} className="text-xs" value={preset.value}>
                        <span
                          className="size-2.5 rounded-full"
                          style={{
                            backgroundColor:
                              resolvedThemeMode === 'dark' ? preset.primary.dark : preset.primary.light,
                          }}
                        />
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Content Layout</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={contentLayout}
                onValueChange={onContentLayoutChange}
              >
                <ToggleGroupItem value="centered">Centered</ToggleGroupItem>
                <ToggleGroupItem value="full-width">Full Width</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Navbar Style</Label>
              <ToggleGroup type="single" variant="outline" value={navbarStyle} onValueChange={onNavbarStyleChange}>
                <ToggleGroupItem value="sticky">Sticky</ToggleGroupItem>
                <ToggleGroupItem value="scroll">Scroll</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Sidebar Variant</Label>
              <ToggleGroup type="single" variant="outline" value={variant} onValueChange={onSidebarStyleChange}>
                <ToggleGroupItem value="sidebar">Sidebar</ToggleGroupItem>
                <ToggleGroupItem value="floating">Floating</ToggleGroupItem>
                <ToggleGroupItem value="inset">Inset</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="font-medium text-xs">Sidebar Collapsible</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={collapsible}
                onValueChange={onSidebarCollapseModeChange}
              >
                <ToggleGroupItem value="icon">Icon</ToggleGroupItem>
                <ToggleGroupItem value="offcanvas">Offcanvas</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <Button type="button" size="sm" variant="outline" className="w-full text-xs" onClick={resetPreferences}>
              Restore Defaults
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
