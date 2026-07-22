import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Loader2, Video, Settings, LogOut, Upload, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import Login from "@/pages/login";
import Blocked from "@/pages/blocked";
import { UploadDialog } from "@/components/upload-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useState, useEffect } from "react";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: me, isLoading, error } = useGetMe();
  const logout = useLogout();
  const [uploadOpen, setUploadOpen] = useState(false);
  
  // Use window.location directly so we catch initial load properly without Wouter route interference
  const [isBlocked, setIsBlocked] = useState(false);
  
  useEffect(() => {
    if (window.location.search.includes("authError=not_member")) {
      setIsBlocked(true);
    }
  }, []);

  if (isBlocked) {
    return <Blocked />;
  }

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="w-12 h-12 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !me) {
    return <Login />;
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 transition-transform hover:scale-[1.02] active:scale-[0.98]">
            <div className="w-12 h-12 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center shadow-lg shadow-primary/20 rotate-3 group-hover:rotate-6 transition-all">
              <Video className="w-7 h-7" />
            </div>
            <span className="font-display font-black text-2xl tracking-tight hidden sm:inline-block text-foreground">clipp'n'k</span>
          </Link>

          <div className="flex items-center gap-3 sm:gap-6">
            <Button onClick={() => setUploadOpen(true)} className="rounded-full shadow-lg shadow-primary/20 font-bold px-6 h-12 text-base hover:-translate-y-0.5 transition-transform">
              <Upload className="w-5 h-5 mr-2" />
              Upload
            </Button>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full w-12 h-12 ring-2 ring-transparent hover:ring-primary/20 transition-all p-0">
                  <Avatar className="w-12 h-12 border border-border">
                    <AvatarImage src={me.avatarUrl || undefined} alt={me.username} />
                    <AvatarFallback className="bg-muted"><User className="w-5 h-5" /></AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 font-sans p-2 rounded-xl border shadow-xl">
                <div className="px-3 py-3 flex flex-col space-y-1 bg-muted/50 rounded-lg mb-2">
                  <p className="text-base font-semibold leading-none text-foreground">{me.username}</p>
                  <p className="text-xs text-muted-foreground truncate">{me.discordId}</p>
                </div>
                {me.isAdmin && (
                  <>
                    <DropdownMenuItem asChild className="rounded-lg cursor-pointer py-2">
                      <Link href="/admin">
                        <Settings className="w-4 h-4 mr-2 text-muted-foreground" />
                        <span className="font-medium">Site Settings</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="my-1" />
                  </>
                )}
                <DropdownMenuItem 
                  className="text-destructive focus:bg-destructive/10 cursor-pointer rounded-lg py-2"
                  onClick={() => {
                    logout.mutate(undefined, {
                      onSuccess: () => setLocation("/")
                    });
                  }}
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  <span className="font-medium">Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-10">
        {children}
      </main>

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} maxBytes={me.quotaStorageBytes} />
    </div>
  );
}