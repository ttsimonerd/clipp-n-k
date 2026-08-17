import { useState } from "react";
import {
  useListAdminUsers,
  useUpdateAdminUser,
  useDeleteAdminUser,
  getListAdminUsersQueryKey,
  type AdminUser,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { formatBytes, formatDate } from "@/lib/format";
import { Loader2, Ban, ShieldCheck, Trash2, Save, Users } from "lucide-react";

export function UsersSection() {
  const { data: users, isLoading } = useListAdminUsers();
  const updateUser = useUpdateAdminUser();
  const deleteUser = useDeleteAdminUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Per-user quota override draft (in MB, empty = inherit).
  const [overrides, setOverrides] = useState<Record<number, string>>({});

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });

  const handleToggleBan = (user: AdminUser) => {
    updateUser.mutate(
      { id: user.id, data: { banned: !user.banned } },
      {
        onSuccess: () => {
          toast({ title: user.banned ? "User unbanned" : "User banned" });
          invalidate();
        },
      },
    );
  };

  const handleDelete = (user: AdminUser) => {
    if (!window.confirm(`Delete ${user.username} and all of their clips? This cannot be undone.`)) {
      return;
    }
    deleteUser.mutate(
      { id: user.id },
      {
        onSuccess: () => {
          toast({ title: "User deleted" });
          invalidate();
        },
      },
    );
  };

  const handleSaveOverride = (user: AdminUser) => {
    const raw = overrides[user.id] ?? "";
    const trimmed = raw.trim();
    const quotaOverrideBytes = trimmed === "" ? null : Math.round(Number(trimmed) * 1024 * 1024);
    if (quotaOverrideBytes !== null && (Number.isNaN(quotaOverrideBytes) || quotaOverrideBytes < 0)) {
      toast({ title: "Invalid quota", description: "Enter a number of MB, or leave empty to inherit.", variant: "destructive" });
      return;
    }
    updateUser.mutate(
      { id: user.id, data: { quotaOverrideBytes } },
      {
        onSuccess: () => {
          toast({ title: "Quota override saved" });
          invalidate();
        },
      },
    );
  };

  return (
    <Card className="rounded-3xl shadow-sm border-border overflow-hidden">
      <CardHeader className="bg-muted/30 pb-6 border-b">
        <CardTitle className="text-2xl font-display flex items-center gap-2">
          <Users className="w-6 h-6 text-primary" />
          Users
        </CardTitle>
        <CardDescription className="text-base">
          View usage, ban/unban accounts, set per-user quota overrides, and delete users.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        {isLoading || !users ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : users.length === 0 ? (
          <p className="text-muted-foreground py-12 text-center">No users yet.</p>
        ) : (
          <div className="space-y-3">
            {users.map((user) => {
              const overrideDraft = overrides[user.id] ?? (user.quotaOverrideBytes != null ? String(Math.round(user.quotaOverrideBytes / (1024 * 1024))) : "");
              return (
                <div
                  key={user.id}
                  className={`border rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center gap-4 ${user.banned ? "bg-destructive/5 border-destructive/30" : "bg-card"}`}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar className="w-11 h-11 border border-border">
                      <AvatarImage src={user.avatarUrl || undefined} alt={user.username} />
                      <AvatarFallback className="bg-muted text-sm font-bold">
                        {user.username.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold truncate text-foreground">{user.username}</p>
                        {user.isAdmin && (
                          <Badge className="gap-1">
                            <ShieldCheck className="w-3 h-3" />
                            Admin
                          </Badge>
                        )}
                        {user.banned && <Badge variant="destructive">Banned</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{user.discordId}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatBytes(user.usedStorageBytes)} / {formatBytes(user.quotaStorageBytes)} · {user.clipCount} clip{user.clipCount === 1 ? "" : "s"} · joined {formatDate(user.createdAt)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap lg:shrink-0">
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        placeholder="Quota (MB)"
                        value={overrideDraft}
                        onChange={(e) => setOverrides((prev) => ({ ...prev, [user.id]: e.target.value }))}
                        className="w-28 h-9 text-sm font-mono bg-muted/50"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 gap-1.5"
                        onClick={() => handleSaveOverride(user)}
                        disabled={updateUser.isPending}
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant={user.banned ? "secondary" : "outline"}
                      className="h-9 gap-1.5"
                      onClick={() => handleToggleBan(user)}
                      disabled={updateUser.isPending}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      {user.banned ? "Unban" : "Ban"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 gap-1.5 text-destructive hover:bg-destructive/10"
                      onClick={() => handleDelete(user)}
                      disabled={deleteUser.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
