import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClipUpload } from "@/hooks/use-clip-upload";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, X, Film, AlertCircle, Check, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How many files upload at once. Keep small — each upload also enqueues an
 * ffmpeg job server-side (the server caps processing concurrency separately). */
const UPLOAD_CONCURRENCY = 3;

interface UploadItem {
  id: string;
  file: File;
  title: string;
  status: "pending" | "uploading" | "success" | "error";
  progress: number;
  error?: string;
  clipId?: number;
}

export function UploadDialog({ open, onOpenChange, maxBytes }: { open: boolean, onOpenChange: (open: boolean) => void, maxBytes?: number }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { uploadFile, isUploading } = useClipUpload();

  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>(items);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(0);

  // Keep a ref in sync so async batch logic always sees the latest items.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Reset the queue whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setItems([]);
    }
  }, [open]);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      const tooBig: string[] = [];
      const newItems: UploadItem[] = [];
      for (const file of incoming) {
        if (maxBytes && file.size > maxBytes) {
          tooBig.push(file.name);
          continue;
        }
        newItems.push({
          id: `${file.name}-${idCounter.current++}`,
          file,
          title: file.name.replace(/\.[^/.]+$/, ""),
          status: "pending",
          progress: 0,
        });
      }

      if (newItems.length > 0) {
        setItems((prev) => [...prev, ...newItems]);
      }
      if (tooBig.length > 0) {
        toast({
          title: `${tooBig.length} file${tooBig.length === 1 ? "" : "s"} skipped`,
          description: `${tooBig.slice(0, 3).join(", ")}${tooBig.length > 3 ? "…" : ""} exceed${tooBig.length === 1 ? "s" : ""} the size limit.`,
          variant: "destructive",
        });
      }
    },
    [maxBytes, toast],
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    // Allow re-selecting the same file(s) after a failed pick.
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const removeItem = (id: string) => {
    if (isUploading) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const updateItem = (id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const uploadOne = async (item: UploadItem): Promise<{ ok: boolean; clipId?: number }> => {
    updateItem(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const clip = await uploadFile({
        file: item.file,
        title: item.title || undefined,
        onProgress: (pct) => updateItem(item.id, { progress: pct }),
      });
      updateItem(item.id, { status: "success", progress: 100, clipId: clip.id });
      return { ok: true, clipId: clip.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      updateItem(item.id, { status: "error", error: msg });
      return { ok: false };
    }
  };

  const startUpload = useCallback(async () => {
    const pending = itemsRef.current.filter((i) => i.status === "pending");
    if (pending.length === 0) return;

    // Any files already in an error state (e.g. from a previous failed batch)
    // still count as failures in the summary below.
    const preBlocked = itemsRef.current.filter((i) => i.status === "error").length;

    let cursor = 0;
    const runWorker = async () => {
      const results: Array<{ ok: boolean; clipId?: number }> = [];
      while (cursor < pending.length) {
        const item = pending[cursor++];
        results.push(await uploadOne(item));
      }
      return results;
    };

    const workerCount = Math.min(UPLOAD_CONCURRENCY, pending.length);
    const results = (await Promise.all(Array.from({ length: workerCount }, runWorker))).flat();

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok).length + preBlocked;

    if (successes.length > 0 && failures === 0) {
      toast({ title: `Uploaded ${successes.length} clip${successes.length === 1 ? "" : "s"}` });
      onOpenChange(false);
      setItems([]);
      if (successes.length === 1) {
        setLocation(`/clips/${successes[0].clipId}`);
      } else {
        // Batch — land on the dashboard so every new clip is visible.
        setLocation("/");
      }
    } else if (successes.length > 0) {
      toast({
        title: `${successes.length} uploaded, ${failures} failed`,
        description: "Failed clips are still in the list — retry or remove them.",
      });
    } else {
      toast({ title: "Upload failed", variant: "destructive" });
    }
  }, [onOpenChange, setLocation, toast]);

  const retryFailed = () => {
    setItems((prev) =>
      prev.map((i) => (i.status === "error" ? { ...i, status: "pending", progress: 0, error: undefined } : i)),
    );
    // Defer so the state update lands before we read itemsRef.
    setTimeout(() => void startUpload(), 0);
  };

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const successCount = items.filter((i) => i.status === "success").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const uploadingCount = items.filter((i) => i.status === "uploading").length;
  const totalToUpload = pendingCount + uploadingCount + successCount;

  // Single-file mode keeps the editable title field; batch auto-titles from filenames.
  const singlePending = items.length === 1 && items[0].status === "pending";

  return (
    <Dialog open={open} onOpenChange={isUploading ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md font-sans">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Upload Clips</DialogTitle>
          <DialogDescription>
            Share your best gaming moments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {items.length === 0 ? (
            <div
              className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center text-center bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer group"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <UploadCloud className="w-8 h-8" />
              </div>
              <h3 className="font-semibold text-lg mb-1 text-foreground">Click or drag videos here</h3>
              <p className="text-sm text-muted-foreground">Select multiple clips at once — MP4, WebM, or MOV up to the limit</p>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="video/mp4,video/webm,video/quicktime"
                multiple
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
              {singlePending && (
                <div className="space-y-2">
                  <Label htmlFor="title" className="text-foreground">Clip Title (Optional)</Label>
                  <Input
                    id="title"
                    value={items[0].title}
                    onChange={(e) => updateItem(items[0].id, { title: e.target.value })}
                    placeholder="Give it a catchy name"
                    disabled={isUploading}
                    className="bg-muted/50 focus-visible:bg-background h-12 text-lg"
                  />
                </div>
              )}

              {/* File list with per-file status */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {items.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 p-3 border rounded-xl bg-card relative overflow-hidden">
                    <div className="w-10 h-10 bg-primary/10 text-primary rounded-lg flex items-center justify-center shrink-0">
                      {item.status === "success" ? (
                        <Check className="w-5 h-5 text-green-500" />
                      ) : item.status === "error" ? (
                        <AlertCircle className="w-5 h-5 text-destructive" />
                      ) : (
                        <Film className="w-5 h-5" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate text-foreground text-sm" title={item.file.name}>{item.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.status === "uploading"
                          ? `Uploading ${item.progress}%`
                          : item.status === "success"
                            ? "Uploaded"
                            : item.status === "error"
                              ? item.error
                              : formatBytes(item.file.size)}
                      </p>
                      {item.status === "uploading" && (
                        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${item.progress}%` }} />
                        </div>
                      )}
                    </div>
                    {!isUploading && item.status !== "success" && (
                      <Button variant="ghost" size="icon" className="shrink-0 rounded-full h-8 w-8 hover:bg-destructive/10 hover:text-destructive" onClick={() => removeItem(item.id)} title="Remove">
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {errorCount > 0 && !isUploading && (
                <div className="flex items-center justify-between gap-2 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-lg p-3">
                  <span className="flex items-center gap-2 min-w-0">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="truncate">{errorCount} clip{errorCount === 1 ? "" : "s"} failed to upload.</span>
                  </span>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-destructive hover:bg-destructive/10" onClick={retryFailed}>
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-destructive hover:bg-destructive/10" onClick={() => setItems((prev) => prev.filter((i) => i.status !== "error"))}>
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isUploading}>
              Cancel
            </Button>
            <Button
              onClick={() => void startUpload()}
              disabled={pendingCount === 0 || isUploading}
              className={cn("min-w-[140px] font-semibold shadow-lg shadow-primary/20", totalToUpload > 1 && !isUploading && "min-w-[180px]")}
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Uploading {successCount + uploadingCount}/{totalToUpload}
                </>
              ) : pendingCount > 1 ? (
                `Upload ${pendingCount} clips`
              ) : (
                "Upload"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
