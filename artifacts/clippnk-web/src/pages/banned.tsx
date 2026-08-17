import { useLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Ban, Loader2 } from "lucide-react";

export default function Banned() {
  const logout = useLogout();

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40vw] h-[40vw] bg-destructive/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-md w-full text-center space-y-8 relative z-10">
        <div className="mx-auto w-20 h-20 bg-destructive/10 text-destructive rounded-2xl flex items-center justify-center rotate-3">
          <Ban className="w-10 h-10" />
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-display font-bold tracking-tight text-foreground">
            Account Banned
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Your account has been banned by an administrator. If you believe
            this is a mistake, contact the server admin.
          </p>
        </div>

        <div className="pt-4">
          <Button
            variant="outline"
            size="lg"
            className="w-full text-base font-semibold h-14 rounded-xl"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined)}
          >
            {logout.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
            Log out
          </Button>
        </div>
      </div>
    </div>
  );
}
