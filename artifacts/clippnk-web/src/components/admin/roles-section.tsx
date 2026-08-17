import { useEffect, useState } from "react";
import {
  useListDiscordGuildRoles,
  useListDiscordRoleLimits,
  useUpdateDiscordRoleLimits,
  getListDiscordRoleLimitsQueryKey,
  getListDiscordGuildRolesQueryKey,
  type DiscordRoleLimit,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Shield, RefreshCw } from "lucide-react";

interface Row {
  priority: string;
  maxUploadMB: string;
  maxStorageMB: string;
}

const MB = 1024 * 1024;

export function RolesSection({ guildId, botEnabled }: { guildId: string | null; botEnabled: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const guildRoles = useListDiscordGuildRoles({
    query: { enabled: !!guildId && botEnabled, queryKey: getListDiscordGuildRolesQueryKey() },
  });
  const roleLimits = useListDiscordRoleLimits();
  const saveLimits = useUpdateDiscordRoleLimits();

  const [rows, setRows] = useState<Record<string, Row>>({});

  // Seed rows from the configured limits whenever they load.
  useEffect(() => {
    if (!roleLimits.data) return;
    const seeded: Record<string, Row> = {};
    for (const r of roleLimits.data) {
      seeded[r.roleId] = {
        priority: String(r.priority),
        maxUploadMB: r.maxUploadBytes != null ? String(Math.round(r.maxUploadBytes / MB)) : "",
        maxStorageMB: r.maxUserStorageBytes != null ? String(Math.round(r.maxUserStorageBytes / MB)) : "",
      };
    }
    setRows(seeded);
  }, [roleLimits.data]);

  const roles = guildRoles.data ?? [];

  const update = (roleId: string, patch: Partial<Row>) => {
    setRows((prev) => ({ ...prev, [roleId]: { ...prev[roleId], ...patch } }));
  };

  const handleSave = () => {
    const toSave: DiscordRoleLimit[] = roles
      .map((role) => {
        const row = rows[role.id] ?? { priority: "", maxUploadMB: "", maxStorageMB: "" };
        const priority = Number(row.priority) || 0;
        const upload = row.maxUploadMB.trim();
        const storage = row.maxStorageMB.trim();
        const maxUploadBytes = upload === "" ? null : Math.round(Number(upload) * MB);
        const maxUserStorageBytes = storage === "" ? null : Math.round(Number(storage) * MB);

        // Only include roles the admin has actually configured.
        if (priority === 0 && maxUploadBytes === null && maxUserStorageBytes === null) {
          return null;
        }

        return {
          roleId: role.id,
          roleName: role.name,
          priority,
          maxUploadBytes,
          maxUserStorageBytes,
        };
      })
      .filter((r): r is DiscordRoleLimit => r !== null);

    saveLimits.mutate(
      { data: toSave },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDiscordRoleLimitsQueryKey() });
          toast({ title: "Role limits saved" });
        },
        onError: () => {
          toast({ title: "Failed to save role limits", variant: "destructive" });
        },
      },
    );
  };

  const hasInvalidNumber = roles.some((role) => {
    const row = rows[role.id];
    if (!row) return false;
    return (
      (row.maxUploadMB.trim() !== "" && Number.isNaN(Number(row.maxUploadMB))) ||
      (row.maxStorageMB.trim() !== "" && Number.isNaN(Number(row.maxStorageMB))) ||
      (row.priority.trim() !== "" && Number.isNaN(Number(row.priority)))
    );
  });

  return (
    <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
      <CardHeader className="bg-muted/30 pb-6 border-b">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-2xl font-display flex items-center gap-2">
              <Shield className="w-6 h-6 text-primary" />
              Discord Role Limits
            </CardTitle>
            <CardDescription className="text-base mt-1.5">
              Grant different upload/storage limits per Discord role. When a user holds
              several configured roles, the one with the <strong>highest priority</strong> wins.
              Leave a field empty to inherit the site default.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {!guildId ? (
          <p className="text-muted-foreground py-8 text-center">
            Set a Discord Guild ID above to configure per-role limits.
          </p>
        ) : !botEnabled ? (
          <p className="text-muted-foreground py-8 text-center">
            Set a valid <code className="font-mono bg-muted px-1 rounded">DISCORD_BOT_TOKEN</code> to
            fetch guild roles.
          </p>
        ) : guildRoles.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : guildRoles.isError ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-muted-foreground">
              Couldn't fetch guild roles. Make sure the bot is a member of the guild.
            </p>
            <Button variant="outline" onClick={() => guildRoles.refetch()}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_90px_120px_120px] gap-3 px-1 text-sm font-semibold text-muted-foreground hidden md:grid">
              <span>Role</span>
              <span>Priority</span>
              <span>Max upload (MB)</span>
              <span>Max storage (MB)</span>
            </div>
            {roles.map((role) => {
              const row = rows[role.id] ?? { priority: "", maxUploadMB: "", maxStorageMB: "" };
              return (
                <div key={role.id} className="grid grid-cols-1 md:grid-cols-[1fr_90px_120px_120px] gap-3 items-center border rounded-xl p-3 bg-muted/20">
                  <span className="font-medium truncate" title={role.name}>{role.name}</span>
                  <Input
                    type="number"
                    placeholder="0"
                    value={row.priority}
                    onChange={(e) => update(role.id, { priority: e.target.value })}
                    className="h-9 text-sm font-mono bg-muted/50"
                  />
                  <Input
                    type="number"
                    min={0}
                    placeholder="inherit"
                    value={row.maxUploadMB}
                    onChange={(e) => update(role.id, { maxUploadMB: e.target.value })}
                    className="h-9 text-sm font-mono bg-muted/50"
                  />
                  <Input
                    type="number"
                    min={0}
                    placeholder="inherit"
                    value={row.maxStorageMB}
                    onChange={(e) => update(role.id, { maxStorageMB: e.target.value })}
                    className="h-9 text-sm font-mono bg-muted/50"
                  />
                </div>
              );
            })}

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={saveLimits.isPending || hasInvalidNumber}
                className="h-11 px-6 font-bold gap-2"
              >
                {saveLimits.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Role Limits
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
