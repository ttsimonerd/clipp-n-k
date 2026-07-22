import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { 
  useGetClip, getGetClipQueryKey, useUpdateClip, useDeleteClip, useTrimClip
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { 
  Loader2, ArrowLeft, Trash2, Scissors, Save, Globe, Lock, AlertCircle, Share2, Play
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function ClipView() {
  const [, params] = useRoute("/clips/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: clip, isLoading, error } = useGetClip(id, {
    query: {
      queryKey: getGetClipQueryKey(id),
      refetchInterval: (query) => {
        const data = query.state.data;
        return data?.status === 'processing' ? 2000 : false;
      }
    }
  });

  const updateClip = useUpdateClip();
  const deleteClip = useDeleteClip();
  const trimClip = useTrimClip();

  const videoRef = useRef<HTMLVideoElement>(null);
  
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimRange, setTrimRange] = useState([0, 100]);
  
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (clip && !isEditingTitle) {
      setEditTitle(clip.title);
      if (clip.durationSeconds && !isTrimming) {
        setTrimRange([0, clip.durationSeconds]);
      }
    }
  }, [clip, isEditingTitle, isTrimming]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isTrimming || !clip?.durationSeconds) return;

    const handleTimeUpdate = () => {
      if (video.currentTime > trimRange[1]) {
        video.currentTime = trimRange[0];
        video.play();
      }
      if (video.currentTime < trimRange[0]) {
        video.currentTime = trimRange[0];
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [isTrimming, trimRange, clip]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-6 text-center animate-in fade-in">
        <AlertCircle className="w-16 h-16 text-destructive" />
        <h2 className="text-3xl font-display font-bold text-foreground">Clip not found</h2>
        <p className="text-muted-foreground text-lg">It might have been deleted or you don't have access.</p>
        <Button size="lg" className="mt-4" onClick={() => setLocation("/")}>Go Back Home</Button>
      </div>
    );
  }

  if (isLoading || !clip) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-12 h-12 animate-spin text-primary" />
      </div>
    );
  }

  const handleTitleSave = () => {
    if (editTitle.trim() === "" || editTitle === clip.title) {
      setIsEditingTitle(false);
      setEditTitle(clip.title);
      return;
    }
    
    updateClip.mutate({ id, data: { title: editTitle } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetClipQueryKey(id), data);
        setIsEditingTitle(false);
        toast({ title: "Title updated successfully" });
      }
    });
  };

  const handleVisibilityToggle = () => {
    const newVis = clip.visibility === 'public' ? 'private' : 'public';
    updateClip.mutate({ id, data: { visibility: newVis } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetClipQueryKey(id), data);
        toast({ title: `Clip is now ${newVis}` });
      }
    });
  };

  const handleTrimSave = () => {
    trimClip.mutate({ 
      id, 
      data: { startSeconds: trimRange[0], endSeconds: trimRange[1] } 
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetClipQueryKey(id), data);
        setIsTrimming(false);
        toast({ title: "Trim started", description: "Your clip is being reprocessed." });
      }
    });
  };

  const handleDelete = () => {
    deleteClip.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Clip deleted" });
        setLocation("/");
      }
    });
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(clip.shareUrl);
    toast({ title: "Link copied to clipboard!" });
  };

  const isProcessing = clip.status === 'processing';
  const isFailed = clip.status === 'failed';
  
  // Owner-authenticated playback URL, populated once processing has finished.
  const videoUrl = clip.videoUrl;

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20 animate-in fade-in duration-500">
      <Button variant="ghost" onClick={() => setLocation("/")} className="mb-2 hover:-translate-x-1 transition-transform text-muted-foreground hover:text-foreground font-semibold">
        <ArrowLeft className="w-5 h-5 mr-2" /> Back to Dashboard
      </Button>

      {/* Main Video Area */}
      <div className="bg-black rounded-3xl overflow-hidden shadow-2xl shadow-primary/5 border border-border">
        <div className="aspect-video relative flex items-center justify-center w-full">
          {isProcessing ? (
            <div className="flex flex-col items-center text-white space-y-6">
              <Loader2 className="w-16 h-16 animate-spin text-primary" />
              <p className="text-xl font-display font-bold tracking-widest uppercase animate-pulse">Processing video...</p>
            </div>
          ) : isFailed ? (
            <div className="flex flex-col items-center text-destructive space-y-4 p-8 text-center bg-destructive/10 rounded-2xl">
              <AlertCircle className="w-16 h-16" />
              <p className="text-2xl font-bold font-display">Processing failed</p>
              <p className="text-lg opacity-90">{clip.failureReason || "Unknown error occurred during processing."}</p>
            </div>
          ) : (
            <video 
              ref={videoRef}
              src={videoUrl ?? undefined}
              controls={!isTrimming}
              className={`w-full h-full object-contain ${isTrimming ? 'pointer-events-none' : ''}`}
              poster={clip.thumbnailUrl || undefined}
              preload="metadata"
              playsInline
            />
          )}
        </div>

        {/* Trim Controls */}
        {isTrimming && clip.durationSeconds && (
          <div className="bg-sidebar p-8 border-t border-border animate-in slide-in-from-bottom-8 duration-300">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-display font-bold text-xl flex items-center text-foreground"><Scissors className="w-5 h-5 mr-2 text-primary" /> Trim Clip</h3>
              <div className="text-base font-mono font-bold bg-primary/10 text-primary px-3 py-1 rounded-lg">
                {(trimRange[1] - trimRange[0]).toFixed(1)}s
              </div>
            </div>
            
            <div className="px-4 pb-8">
              <Slider 
                min={0} 
                max={clip.durationSeconds} 
                step={0.1}
                value={trimRange}
                onValueChange={(vals) => {
                  setTrimRange(vals);
                  if (videoRef.current) {
                    videoRef.current.currentTime = vals[0];
                  }
                }}
                className="my-6"
              />
              <div className="flex justify-between text-sm font-bold text-muted-foreground mt-4">
                <span>0:00</span>
                <span>{formatDuration(clip.durationSeconds)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-4 mt-2">
              <Button variant="ghost" size="lg" onClick={() => setIsTrimming(false)} className="font-semibold">Cancel</Button>
              <Button size="lg" onClick={handleTrimSave} disabled={trimClip.isPending} className="font-semibold shadow-lg shadow-primary/20 min-w-[140px]">
                {trimClip.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />}
                Save Trim
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Metadata & Actions */}
      <div className="flex flex-col lg:flex-row gap-10">
        <div className="flex-1 space-y-6">
          <div className="space-y-4 bg-card border border-border p-8 rounded-3xl shadow-sm">
            {isEditingTitle ? (
              <div className="flex items-center gap-3">
                <Input 
                  value={editTitle} 
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="text-3xl font-display font-bold h-auto py-3 bg-muted/50 border-primary"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTitleSave();
                    if (e.key === 'Escape') setIsEditingTitle(false);
                  }}
                />
                <Button size="icon" className="h-14 w-14 shrink-0 shadow-lg" onClick={handleTitleSave} disabled={updateClip.isPending}>
                  {updateClip.isPending ? <Loader2 className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />}
                </Button>
              </div>
            ) : (
              <h1 
                className="text-4xl lg:text-5xl font-display font-bold tracking-tight cursor-pointer hover:text-primary transition-colors group flex items-center text-foreground"
                onClick={() => !isProcessing && setIsEditingTitle(true)}
                title="Click to edit title"
              >
                {clip.title}
              </h1>
            )}
            
            <div className="flex flex-wrap items-center gap-4 text-base text-muted-foreground font-semibold">
              <span className="bg-secondary text-secondary-foreground px-3 py-1 rounded-lg">{formatDate(clip.createdAt)}</span>
              <span className="text-border">&bull;</span>
              <span>{formatBytes(clip.sizeBytes)}</span>
              {clip.durationSeconds && (
                <>
                  <span className="text-border">&bull;</span>
                  <span>{formatDuration(clip.durationSeconds)}</span>
                </>
              )}
              {clip.width && clip.height && (
                <>
                  <span className="text-border">&bull;</span>
                  <span>{clip.width}x{clip.height}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="w-full lg:w-96 flex flex-col gap-4 shrink-0 bg-card border border-border p-6 rounded-3xl shadow-sm">
          <Button 
            size="lg" 
            className="w-full text-lg font-bold h-14 shadow-xl shadow-primary/20 hover:-translate-y-1 transition-transform"
            onClick={handleCopyLink}
          >
            <Share2 className="w-6 h-6 mr-3" />
            Copy Share Link
          </Button>

          <div className="grid grid-cols-2 gap-4">
            <Button 
              variant={clip.visibility === 'public' ? 'outline' : 'secondary'} 
              size="lg"
              className={`w-full font-bold h-12 ${clip.visibility === 'public' ? 'border-primary text-primary hover:bg-primary/5 shadow-inner' : ''}`}
              onClick={handleVisibilityToggle}
              disabled={isProcessing || updateClip.isPending}
            >
              {clip.visibility === 'public' ? <Globe className="w-5 h-5 mr-2" /> : <Lock className="w-5 h-5 mr-2" />}
              {clip.visibility === 'public' ? 'Public' : 'Private'}
            </Button>
            
            <Button 
              variant="secondary" 
              size="lg"
              className="w-full font-bold h-12"
              onClick={() => setIsTrimming(true)}
              disabled={isProcessing || !clip.durationSeconds || isTrimming}
            >
              <Scissors className="w-5 h-5 mr-2" />
              Trim
            </Button>
          </div>

          <Separator className="my-2 bg-border" />

          <Button 
            variant="ghost" 
            size="lg"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive font-bold h-12"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteClip.isPending}
          >
            <Trash2 className="w-5 h-5 mr-2" />
            Delete Clip
          </Button>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="font-sans sm:max-w-md border-destructive/20 shadow-2xl shadow-destructive/10">
          <DialogHeader>
            <DialogTitle className="text-2xl font-display text-destructive flex items-center">
              <AlertCircle className="w-6 h-6 mr-2" /> Delete Clip
            </DialogTitle>
            <DialogDescription className="text-base mt-2">
              Are you sure you want to delete <span className="font-bold text-foreground">"{clip.title}"</span>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-0 mt-6">
            <Button variant="ghost" size="lg" onClick={() => setDeleteOpen(false)} className="font-semibold">Cancel</Button>
            <Button variant="destructive" size="lg" onClick={handleDelete} disabled={deleteClip.isPending} className="font-bold shadow-lg shadow-destructive/20">
              {deleteClip.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Trash2 className="w-5 h-5 mr-2" />}
              Yes, delete it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}