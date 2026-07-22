import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Gamepad2, AlertCircle } from "lucide-react";

export default function Blocked() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40vw] h-[40vw] bg-destructive/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-md w-full text-center space-y-8 relative z-10">
        <div className="mx-auto w-20 h-20 bg-destructive/10 text-destructive rounded-2xl flex items-center justify-center rotate-3">
          <AlertCircle className="w-10 h-10" />
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-display font-bold tracking-tight text-foreground">
            Access Denied
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Sorry, clipp'n'k is a private hub. You must be a member of our Discord server to sign in and share clips.
          </p>
        </div>

        <div className="pt-8">
          <Button asChild size="lg" className="w-full text-base font-semibold h-14 rounded-xl shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-all hover:-translate-y-0.5">
            <a href={`${import.meta.env.BASE_URL}api/auth/discord/login`}>
              <Gamepad2 className="w-5 h-5 mr-2" />
              Try Another Discord Account
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
