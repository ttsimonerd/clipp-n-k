import { useGetMe, useGetAdminSettings, useUpdateAdminSettings, getGetAdminSettingsQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Loader2, Settings2, Save, Copy, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const settingsSchema = z.object({
  discordGuildId: z.string().optional().nullable(),
  brandingTitle: z.string().min(1, "Title is required"),
  brandingPrimaryColor: z.string(),
  maxUploadBytes: z.coerce.number().min(1),
  maxUserStorageBytes: z.coerce.number().min(1),
  maxClipDurationSeconds: z.coerce.number().optional().nullable(),
  defaultVisibility: z.enum(["public", "private"]),
});

export default function Admin() {
  const { data: me } = useGetMe();
  const [, setLocation] = useLocation();
  const { data: settings, isLoading } = useGetAdminSettings();
  const updateSettings = useUpdateAdminSettings();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [discordCopied, setDiscordCopied] = useState(false);

  const githubCallbackUrl = `${window.location.origin}/api/auth/github/callback`;
  const discordCallbackUrl = `${window.location.origin}/api/auth/discord/callback`;

  const handleCopyCallbackUrl = async () => {
    await navigator.clipboard.writeText(githubCallbackUrl);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyDiscordCallbackUrl = async () => {
    await navigator.clipboard.writeText(discordCallbackUrl);
    setDiscordCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setDiscordCopied(false), 2000);
  };

  useEffect(() => {
    if (me && !me.isAdmin) {
      setLocation("/");
    }
  }, [me, setLocation]);

  const form = useForm<z.infer<typeof settingsSchema>>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      brandingTitle: "",
      brandingPrimaryColor: "",
      discordGuildId: "",
      maxUploadBytes: 104857600,
      maxUserStorageBytes: 1073741824,
      maxClipDurationSeconds: null,
      defaultVisibility: "private",
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        brandingTitle: settings.brandingTitle,
        brandingPrimaryColor: settings.brandingPrimaryColor,
        discordGuildId: settings.discordGuildId,
        maxUploadBytes: settings.maxUploadBytes,
        maxUserStorageBytes: settings.maxUserStorageBytes,
        maxClipDurationSeconds: settings.maxClipDurationSeconds,
        defaultVisibility: settings.defaultVisibility,
      });
    }
  }, [settings, form]);

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-12 h-12 animate-spin text-primary" />
      </div>
    );
  }

  const onSubmit = (values: z.infer<typeof settingsSchema>) => {
    updateSettings.mutate({ data: values }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetAdminSettingsQueryKey(), data);
        toast({ title: "Settings updated successfully" });
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-4 bg-card border p-8 rounded-3xl shadow-sm">
        <div className="w-16 h-16 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center shadow-lg shadow-primary/20 rotate-3">
          <Settings2 className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-4xl font-display font-bold tracking-tight text-foreground">Admin Settings</h1>
          <p className="text-muted-foreground text-lg">Manage instance rules and branding constraints.</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
            <CardHeader className="bg-muted/30 pb-6 border-b">
              <CardTitle className="text-2xl font-display">Instance Configuration</CardTitle>
              <CardDescription className="text-base">Global limits and access rules for all users.</CardDescription>
            </CardHeader>
            <CardContent className="p-8 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <FormField
                  control={form.control}
                  name="discordGuildId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Discord Guild ID</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value || ""} className="h-12 text-lg font-mono bg-muted/50" placeholder="e.g. 1234567890" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultVisibility"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Default Clip Visibility</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-12 text-lg bg-muted/50">
                            <SelectValue placeholder="Select visibility" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="private">Private (Only owner)</SelectItem>
                          <SelectItem value="public">Public (Anyone with link)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxUploadBytes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Max Upload Size (Bytes)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} className="h-12 text-lg font-mono bg-muted/50" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxUserStorageBytes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Max Storage per User (Bytes)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} className="h-12 text-lg font-mono bg-muted/50" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
            <CardHeader className="bg-muted/30 pb-6 border-b">
              <CardTitle className="text-2xl font-display">Branding</CardTitle>
              <CardDescription className="text-base">Customize the look and feel of your instance.</CardDescription>
            </CardHeader>
            <CardContent className="p-8 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <FormField
                  control={form.control}
                  name="brandingTitle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Site Title</FormLabel>
                      <FormControl>
                        <Input {...field} className="h-12 text-lg bg-muted/50" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="brandingPrimaryColor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Primary Color (Hex or HSL space-separated)</FormLabel>
                      <FormControl>
                        <Input {...field} className="h-12 text-lg font-mono bg-muted/50" placeholder="e.g. 14 100% 55% or #FF4500" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end pt-4">
            <Button type="submit" size="lg" disabled={updateSettings.isPending} className="h-14 px-10 text-lg font-bold shadow-xl shadow-primary/20 hover:-translate-y-1 transition-transform">
              {updateSettings.isPending ? <Loader2 className="w-6 h-6 animate-spin mr-3" /> : <Save className="w-6 h-6 mr-3" />}
              Save All Settings
            </Button>
          </div>
        </form>
      </Form>

      <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
        <CardHeader className="bg-muted/30 pb-6 border-b">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-2xl font-display">Discord OAuth</CardTitle>
              <CardDescription className="text-base mt-1.5">
                When registering your Discord OAuth2 application, add the redirect URI below under{" "}
                <strong>OAuth2 → Redirects</strong>. Set{" "}
                <code className="font-mono bg-muted px-1 rounded text-sm">DISCORD_CLIENT_ID</code>,{" "}
                <code className="font-mono bg-muted px-1 rounded text-sm">DISCORD_CLIENT_SECRET</code>, and{" "}
                <code className="font-mono bg-muted px-1 rounded text-sm">DISCORD_REDIRECT_URI</code> in your environment.
              </CardDescription>
            </div>
            {settings.discordEnabled ? (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-3 py-1 text-sm font-semibold text-green-600 dark:text-green-400 ring-1 ring-inset ring-green-500/30">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                Active
              </span>
            ) : (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Disabled — env vars not set
              </span>
            )}
          </div>
        </CardHeader>
        <div className="px-8 pt-6 pb-0">
          <div className="flex items-center justify-between border rounded-2xl px-5 py-4 bg-muted/30">
            <div>
              <p className="text-sm font-semibold">Discord Bot Token</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Set <code className="font-mono bg-muted px-1 rounded">DISCORD_BOT_TOKEN</code> to enable guild membership verification.
              </p>
            </div>
            {settings.discordBotEnabled ? (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-3 py-1 text-sm font-semibold text-green-600 dark:text-green-400 ring-1 ring-inset ring-green-500/30">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                Active
              </span>
            ) : (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Disabled — env vars not set
              </span>
            )}
          </div>
        </div>
        <CardContent className="p-8">
          <div className="space-y-2">
            <label className="text-base font-medium leading-none">Redirect URI</label>
            <div className="flex items-center gap-3">
              <Input
                readOnly
                value={discordCallbackUrl}
                className="h-12 text-base font-mono bg-muted/50 cursor-default select-all"
                onFocus={(e) => e.target.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-12 w-12 shrink-0"
                onClick={handleCopyDiscordCallbackUrl}
                aria-label="Copy Discord redirect URI"
              >
                {discordCopied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
        <CardHeader className="bg-muted/30 pb-6 border-b">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-2xl font-display">GitHub OAuth</CardTitle>
              <CardDescription className="text-base mt-1.5">
                When registering your GitHub OAuth App, set the Authorization callback URL to the value below.
                Set <code className="font-mono bg-muted px-1 rounded text-sm">GITHUB_REDIRECT_URI</code> to this same value in your environment.
              </CardDescription>
            </div>
            {settings.githubBonusEnabled ? (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-3 py-1 text-sm font-semibold text-green-600 dark:text-green-400 ring-1 ring-inset ring-green-500/30">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                Active
              </span>
            ) : (
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Disabled — env vars not set
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-8">
          <div className="space-y-2">
            <label className="text-base font-medium leading-none">Authorization Callback URL</label>
            <div className="flex items-center gap-3">
              <Input
                readOnly
                value={githubCallbackUrl}
                className="h-12 text-base font-mono bg-muted/50 cursor-default select-all"
                onFocus={(e) => e.target.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-12 w-12 shrink-0"
                onClick={handleCopyCallbackUrl}
                aria-label="Copy callback URL"
              >
                {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}