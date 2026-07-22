import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClipUpload } from "@/hooks/use-clip-upload";
import { UploadCloud, X, Film, AlertCircle } from "lucide-react";
import { formatBytes } from "@/lib/format";

export function UploadDialog({ open, onOpenChange, maxBytes }: { open: boolean, onOpenChange: (open: boolean) => void, maxBytes?: number }) {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading, progress, error: uploadError } = useClipUpload();
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || uploadError;

  const handleFile = (selectedFile: File) => {
    setLocalError(null);
    if (maxBytes && selectedFile.size > maxBytes) {
      setLocalError(`File exceeds maximum size of ${formatBytes(maxBytes)}`);
      // We still set it, just show warning. The server will reject it anyway if it enforces it.
    }
    setFile(selectedFile);
    if (!title) {
      const name = selectedFile.name.replace(/\.[^/.]+$/, "");
      setTitle(name);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleUpload = () => {
    if (!file) return;
    upload({
      file,
      title: title || undefined,
      onSuccess: (clip) => {
        onOpenChange(false);
        setFile(null);
        setTitle("");
        setLocation(`/clips/${clip.id}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={isUploading ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md font-sans">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Upload Clip</DialogTitle>
          <DialogDescription>
            Share your best gaming moments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {!file ? (
            <div 
              className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center text-center bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer group"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <UploadCloud className="w-8 h-8" />
              </div>
              <h3 className="font-semibold text-lg mb-1 text-foreground">Click or drag a video here</h3>
              <p className="text-sm text-muted-foreground">MP4, WebM, or MOV up to the limit</p>
              <input 
                type="file" 
                ref={fileInputRef} 
                className="hidden" 
                accept="video/mp4,video/webm,video/quicktime" 
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-start gap-4 p-4 border rounded-xl bg-card relative overflow-hidden shadow-sm">
                <div className="w-12 h-12 bg-primary/10 text-primary rounded-lg flex items-center justify-center shrink-0">
                  <Film className="w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate text-foreground" title={file.name}>{file.name}</p>
                  <p className="text-sm text-muted-foreground">{formatBytes(file.size)}</p>
                </div>
                {!isUploading && (
                  <Button variant="ghost" size="icon" className="shrink-0 rounded-full hover:bg-destructive/10 hover:text-destructive" onClick={() => setFile(null)}>
                    <X className="w-4 h-4" />
                  </Button>
                )}
                {isUploading && (
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-muted">
                    <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="title" className="text-foreground">Clip Title (Optional)</Label>
                <Input 
                  id="title" 
                  value={title} 
                  onChange={(e) => setTitle(e.target.value)} 
                  placeholder="Give it a catchy name"
                  disabled={isUploading}
                  className="bg-muted/50 focus-visible:bg-background h-12 text-lg"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 p-3 rounded-lg animate-in slide-in-from-top-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isUploading}>
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={!file || isUploading} className="min-w-[120px] font-semibold shadow-lg shadow-primary/20">
              {isUploading ? `Uploading ${progress}%` : 'Upload'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}