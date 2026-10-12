import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Only same-origin relative paths, to avoid an open redirect. */
export function safeRedirect(target: unknown): string {
  if (
    typeof target !== "string" ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.startsWith("/\\")
  ) {
    return "/";
  }
  return target;
}

export function LoginPage() {
  const { redirect } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const signIn = useMutation({
    mutationFn: () => endpoints.signIn(apiKey.trim()),
    onSuccess: (session) => {
      setApiKey("");
      // Nothing cached under a previous identity may leak into this session.
      client.clear();
      client.setQueryData(queries.session().queryKey, session);
      void navigate({ to: safeRedirect(redirect) });
    },
  });

  return (
    <div className="grid min-h-full place-items-center px-6">
      <Card className="w-full max-w-sm px-6 py-6">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-4 rounded bg-accent" />
          <h1 className="text-title font-semibold">Sign in to matrix</h1>
        </div>
        <p className="mt-2 text-body text-fg-secondary">
          Paste a <span className="font-mono text-fg">human</span> API key. It is exchanged once for
          a session cookie and never stored in the browser.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim()) signIn.mutate();
          }}
        >
          <label className="block">
            <span className="text-label text-fg-secondary">API key</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="mt-1 h-9 w-full rounded-control border border-border-strong bg-canvas px-3 font-mono text-body outline-none focus:border-accent"
            />
          </label>
          {signIn.isError ? (
            <p role="alert" className="text-caption text-danger">
              Sign-in failed: {signIn.error.message}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={!apiKey.trim() || signIn.isPending}
          >
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
