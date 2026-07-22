/**
 * Promotional banner for the +1 GB GitHub-star bonus.
 *
 * States:
 *  1. Not connected  → invite to connect (dismissible)
 *  2. Connected, not starred → prompt to star + re-check button
 *  3. Connected, starred, bonus granted → nothing rendered
 *  4. githubError query param → show inline error
 */
import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Github, Star, X, CheckCircle2, ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGithubCheckStar, useGithubDisconnect, getGetMeQueryKey } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";

const DISMISSED_KEY = "clippnk:github-bonus-dismissed";
const RATE_LIMIT_UNTIL_KEY = "clippnk:github-recheck-cooldown-until";
const COOLDOWN_SECONDS = 60;
const REPO_URL = "https://github.com/ttsimonerd/clipp-n-k";

interface Props {
  me: Me;
}

export function GithubBonusBanner({ me }: Props) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [justLinked, setJustLinked] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [justGranted, setJustGranted] = useState(false);
  const [cooldownSecsLeft, setCooldownSecsLeft] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkStarInFlight = useRef(false);

  function startCooldown() {
    const until = Date.now() + COOLDOWN_SECONDS * 1000;
    localStorage.setItem(RATE_LIMIT_UNTIL_KEY, String(until));
    const remaining = Math.ceil((until - Date.now()) / 1000);
    setCooldownSecsLeft(remaining);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      const secsLeft = Math.ceil((until - Date.now()) / 1000);
      if (secsLeft <= 0) {
        clearInterval(cooldownTimer.current!);
        cooldownTimer.current = null;
        localStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
        setCooldownSecsLeft(0);
      } else {
        setCooldownSecsLeft(secsLeft);
      }
    }, 500);
  }

  const checkStar = useGithubCheckStar({
    mutation: {
      onSuccess(data) {
        checkStarInFlight.current = false;
        if (data.bonusGranted) {
          setJustGranted(true);
          // Refresh /me so quotaStorageBytes and githubStarBonusGranted update immediately.
          qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
        }
      },
      onError(err) {
        checkStarInFlight.current = false;
        const code = (err as { body?: { error?: string } })?.body?.error;
        if (code === "rate_limited") {
          startCooldown();
        }
      },
    },
  });

  const disconnect = useGithubDisconnect({
    mutation: {
      onSuccess() {
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
    },
  });

  useEffect(() => {
    // Read localStorage once on mount.
    setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");

    // Restore any active rate-limit cooldown from a previous session.
    const storedUntil = Number(localStorage.getItem(RATE_LIMIT_UNTIL_KEY) ?? "0");
    if (storedUntil > Date.now()) {
      const remaining = Math.ceil((storedUntil - Date.now()) / 1000);
      setCooldownSecsLeft(remaining);
      cooldownTimer.current = setInterval(() => {
        const secsLeft = Math.ceil((storedUntil - Date.now()) / 1000);
        if (secsLeft <= 0) {
          clearInterval(cooldownTimer.current!);
          cooldownTimer.current = null;
          localStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
          setCooldownSecsLeft(0);
        } else {
          setCooldownSecsLeft(secsLeft);
        }
      }, 500);
    } else {
      localStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
    }

    // Check query-string flags from the OAuth redirect.
    const params = new URLSearchParams(window.location.search);
    if (params.get("githubLinked") === "1") {
      setJustLinked(true);
      // Clean up the URL without a reload.
      const clean = window.location.pathname;
      window.history.replaceState(null, "", clean);
      // Auto-trigger re-check if not yet granted.
      if (!me.githubStarBonusGranted && !checkStarInFlight.current) {
        checkStarInFlight.current = true;
        checkStar.mutate();
      }
    }
    const errParam = params.get("githubError");
    if (errParam) {
      setGithubError(errParam);
      window.history.replaceState(null, "", window.location.pathname);
    }

    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  // ── Bonus already granted ────────────────────────────────────────────────────
  if (me.githubStarBonusGranted && !justGranted) {
    return null;
  }

  // ── Just-granted celebration ─────────────────────────────────────────────────
  if (justGranted || (me.githubStarBonusGranted && justGranted)) {
    return (
      <div className="rounded-3xl border border-green-500/30 bg-green-500/10 p-6 flex items-center gap-4 animate-in fade-in duration-500">
        <CheckCircle2 className="w-7 h-7 text-green-500 shrink-0" />
        <div>
          <p className="font-semibold text-foreground">+1 GB bonus unlocked! 🎉</p>
          <p className="text-sm text-muted-foreground">Thanks for starring the repo. Your quota is now 2 GB.</p>
        </div>
      </div>
    );
  }

  // ── Dismissed (and bonus not yet granted) ────────────────────────────────────
  if (dismissed && !justLinked && !githubError) {
    return null;
  }

  // ── GitHub connected but star not verified yet ───────────────────────────────
  if (me.githubUsername) {
    const reCheckPending = checkStar.isPending;
    const checkStarErrorCode = checkStar.isError
      ? (checkStar.error as { body?: { error?: string } })?.body?.error
      : undefined;
    const noToken = checkStarErrorCode === "no_token_cached";
    const tokenInvalid = checkStarErrorCode === "token_invalid";
    const rateLimited = cooldownSecsLeft > 0 || checkStarErrorCode === "rate_limited";

    return (
      <div className="rounded-3xl border border-yellow-500/30 bg-yellow-500/10 p-6 flex flex-col sm:flex-row sm:items-center gap-4 animate-in fade-in duration-500">
        <Star className="w-7 h-7 text-yellow-500 shrink-0 hidden sm:block" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground flex items-center gap-2">
            <Star className="w-5 h-5 text-yellow-500 sm:hidden" />
            One step left — star the repo for +1 GB
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Connected as{" "}
            <a
              href={`https://github.com/${me.githubUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              @{me.githubUsername}
            </a>
            . Star{" "}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              ttsimonerd/clipp-n-k
            </a>{" "}
            on GitHub, then click Re-check.
          </p>
          {githubError && (
            <p className="text-sm text-destructive mt-1">Error: {githubError}</p>
          )}
          {tokenInvalid && (
            <p className="text-sm text-destructive mt-1">
              Your GitHub access was revoked. Re-link your account to continue.
            </p>
          )}
          {rateLimited && (
            <p className="text-sm text-destructive mt-1">
              GitHub is rate-limiting requests right now. Try again in a minute.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button asChild size="sm" variant="outline" className="rounded-full gap-1.5">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <Star className="w-4 h-4" />
              Star
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          </Button>
          {noToken || tokenInvalid ? (
            <Button asChild size="sm" className="rounded-full gap-1.5">
              <a href={`${import.meta.env.BASE_URL}api/auth/github/link`}>
                <RefreshCw className="w-4 h-4" />
                Re-link &amp; check
              </a>
            </Button>
          ) : (
            <Button
              size="sm"
              className="rounded-full gap-1.5"
              onClick={() => {
                if (checkStarInFlight.current) return;
                checkStarInFlight.current = true;
                checkStar.mutate();
              }}
              disabled={reCheckPending || cooldownSecsLeft > 0}
            >
              {reCheckPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <RefreshCw className="w-4 h-4" />}
              {cooldownSecsLeft > 0 ? `Try again in ${cooldownSecsLeft} s` : "Re-check"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full gap-1.5 text-muted-foreground"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            title="Disconnect GitHub"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    );
  }

  // ── Not connected yet ────────────────────────────────────────────────────────
  return (
    <div className="rounded-3xl border border-primary/20 bg-primary/5 p-6 flex flex-col sm:flex-row sm:items-center gap-4 animate-in fade-in duration-500">
      <Github className="w-8 h-8 text-primary shrink-0 hidden sm:block" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-foreground flex items-center gap-2">
          <Github className="w-5 h-5 text-primary sm:hidden" />
          Get +1 GB free — star us on GitHub
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your GitHub account and star{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            ttsimonerd/clipp-n-k
          </a>{" "}
          to unlock a permanent 2 GB quota.
        </p>
        {githubError && (
          <p className="text-sm text-destructive mt-1">
            {githubError === "already_linked"
              ? "That GitHub account is already linked to another user."
              : githubError === "not_configured"
              ? "GitHub integration isn't configured on this server."
              : `Something went wrong (${githubError}). Try again.`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button asChild size="sm" className="rounded-full gap-2 shadow-md shadow-primary/20">
          <a href={`${import.meta.env.BASE_URL}api/auth/github/link`}>
            <Github className="w-4 h-4" />
            Connect GitHub
          </a>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="rounded-full w-8 h-8 text-muted-foreground"
          onClick={dismiss}
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
