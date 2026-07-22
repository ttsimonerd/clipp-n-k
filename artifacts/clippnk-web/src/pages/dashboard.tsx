import { useGetMe, useListClips } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatBytes, formatDuration, formatDate } from "@/lib/format";
import { Progress } from "@/components/ui/progress";
import { Loader2, Play, Lock, Globe, Film } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GithubBonusBanner } from "@/components/github-bonus-banner";

export default function Dashboard() {
  const { data: me } = useGetMe();
  const { data: clips, isLoading } = useListClips();

  if (isLoading || !me) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const usagePercent = Math.min(100, Math.round((me.usedStorageBytes / me.quotaStorageBytes) * 100));
  const isNearLimit = usagePercent > 85;

  return (
    <div className="space-y-12 animate-in fade-in duration-500 pb-20">
      {/* GitHub star bonus promo */}
      {!me.githubStarBonusGranted && (
        <GithubBonusBanner me={me} />
      )}

      {/* Storage Banner */}
      <section className="bg-card border border-border rounded-3xl p-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
          <div className="space-y-2">
            <h2 className="text-2xl font-display font-bold tracking-tight text-foreground">Storage Usage</h2>
            <p className="text-muted-foreground text-base">
              <span className="font-semibold text-foreground">{formatBytes(me.usedStorageBytes)}</span> used of {formatBytes(me.quotaStorageBytes)}
            </p>
          </div>
          <div className="flex-1 max-w-lg w-full">
            <div className="flex justify-between text-sm font-bold mb-3">
              <span className={isNearLimit ? "text-destructive" : "text-primary"}>{usagePercent}%</span>
              <span className="text-muted-foreground">100%</span>
            </div>
            <Progress 
              value={usagePercent} 
              className="h-4 bg-muted/50 rounded-full" 
              indicatorClassName={`${isNearLimit ? "bg-destructive" : "bg-primary"} rounded-full shadow-sm`} 
            />
          </div>
        </div>
      </section>

      {/* Clips Grid */}
      <section className="space-y-8">
        <div className="flex items-center justify-between">
          <h2 className="text-4xl font-display font-bold tracking-tight text-foreground">Your Clips</h2>
          <Badge variant="secondary" className="px-4 py-1.5 text-base font-semibold rounded-full bg-secondary text-secondary-foreground">
            {clips?.length || 0} Total
          </Badge>
        </div>

        {!clips || clips.length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-3xl p-16 text-center flex flex-col items-center justify-center bg-muted/20">
            <div className="w-24 h-24 bg-muted/50 rounded-full flex items-center justify-center mb-6">
              <Film className="w-12 h-12 text-muted-foreground/50" />
            </div>
            <h3 className="text-2xl font-display font-bold text-foreground mb-3">No clips yet</h3>
            <p className="max-w-md text-lg text-muted-foreground">You haven't uploaded any clips. Drop a video in the upload menu to get your highlight reel started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
            {clips.map(clip => (
              <Link key={clip.id} href={`/clips/${clip.id}`}>
                <Card className="group cursor-pointer overflow-hidden border border-border bg-card hover:border-primary/30 hover:shadow-2xl hover:shadow-primary/5 hover:-translate-y-1 transition-all duration-300 rounded-2xl">
                  <div className="aspect-video bg-black relative overflow-hidden">
                    {clip.thumbnailUrl ? (
                      <img src={clip.thumbnailUrl} alt={clip.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground opacity-50">
                        {clip.status === 'processing' ? (
                          <div className="flex flex-col items-center">
                            <Loader2 className="w-10 h-10 animate-spin mb-2" />
                            <span className="text-xs font-bold uppercase tracking-widest">Processing</span>
                          </div>
                        ) : (
                          <Film className="w-12 h-12" />
                        )}
                      </div>
                    )}
                    
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80" />

                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                      <Badge variant="outline" className="bg-black/60 text-white border-white/10 backdrop-blur-md font-mono font-bold px-2 py-0.5">
                        {formatDuration(clip.durationSeconds)}
                      </Badge>
                      {clip.visibility === 'public' ? (
                        <Globe className="w-5 h-5 text-white drop-shadow-md" />
                      ) : (
                        <Lock className="w-5 h-5 text-white/70" />
                      )}
                    </div>

                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                      <div className="w-14 h-14 bg-primary text-white rounded-full flex items-center justify-center shadow-2xl transform scale-50 group-hover:scale-100 transition-transform duration-300">
                        <Play className="w-6 h-6 ml-1" />
                      </div>
                    </div>
                  </div>
                  <CardContent className="p-5">
                    <h3 className="font-display font-bold text-xl truncate group-hover:text-primary transition-colors text-foreground">{clip.title}</h3>
                    <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground font-medium">
                      <span>{formatDate(clip.createdAt)}</span>
                      <span>{formatBytes(clip.sizeBytes)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}