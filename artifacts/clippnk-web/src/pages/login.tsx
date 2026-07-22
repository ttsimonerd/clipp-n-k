import { Gamepad2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Login() {
  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Left panel - Visual/Brand */}
      <div className="hidden md:flex flex-1 relative bg-sidebar-primary overflow-hidden items-center justify-center">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-primary/20 via-transparent to-transparent opacity-50" />
        
        {/* Kinetic decoration */}
        <div className="relative z-10 grid grid-cols-2 gap-4 p-8 transform -rotate-6 scale-110 opacity-20">
          <div className="w-48 h-32 bg-primary rounded-xl" />
          <div className="w-48 h-32 bg-primary/50 rounded-xl translate-y-8" />
          <div className="w-48 h-32 bg-primary/30 rounded-xl -translate-y-8" />
          <div className="w-48 h-32 bg-primary/80 rounded-xl" />
        </div>

        <div className="absolute z-20 text-center space-y-6 max-w-lg px-8">
          <div className="mx-auto w-24 h-24 bg-primary text-primary-foreground rounded-3xl flex items-center justify-center rotate-3 shadow-2xl shadow-primary/30">
            <Video className="w-12 h-12" />
          </div>
          <h2 className="text-4xl font-display font-bold text-white tracking-tight">
            Clip it. Share it. Done.
          </h2>
          <p className="text-sidebar-foreground text-lg leading-relaxed">
            The private hub for your squad's best moments, clutches, and fails.
          </p>
        </div>
      </div>

      {/* Right panel - Auth */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
        {/* Mobile branding */}
        <div className="md:hidden flex flex-col items-center mb-12 space-y-4">
          <div className="w-16 h-16 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center rotate-3 shadow-xl shadow-primary/30">
            <Video className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-display font-bold text-foreground">clipp'n'k</h1>
        </div>

        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-3 text-center md:text-left">
            <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="text-muted-foreground text-lg">
              Sign in with your Discord account to access the hub.
            </p>
          </div>

          <div className="pt-4">
            <Button asChild size="lg" className="w-full text-base font-semibold h-14 rounded-xl shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-all hover:-translate-y-0.5">
              <a href={`${import.meta.env.BASE_URL}api/auth/discord/login`}>
                <Gamepad2 className="w-5 h-5 mr-2" />
                Sign in with Discord
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
