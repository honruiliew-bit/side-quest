"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, getToken, setToken } from "./api";
import type { AppConfig, UserLite } from "./types";

type Toast = { id: number; text: string; tone: "info" | "money" | "error" };

type Session = {
  config: AppConfig | null;
  user: UserLite | null;
  personas: UserLite[];
  ready: boolean;
  signInAs: (persona: string) => Promise<void>;
  signIn: (name: string, email: string) => Promise<void>;
  signOut: () => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
};

const Ctx = createContext<Session | null>(null);

const DEFAULT_PERSONA = "leo";
const USER_KEY = "sidequest.user";

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<UserLite | null>(null);
  const [personas, setPersonas] = useState<UserLite[]>([]);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const remember = (u: UserLite | null) => {
    setUser(u);
    try {
      if (u) window.localStorage.setItem(USER_KEY, JSON.stringify(u));
      else window.localStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  };

  const signInAs = useCallback(async (persona: string) => {
    const res = await api<{ token: string; user: UserLite }>("/auth/demo", { method: "POST", json: { persona } });
    setToken(res.token);
    remember(res.user);
  }, []);

  const signIn = useCallback(async (name: string, email: string) => {
    const res = await api<{ token: string; user: UserLite }>("/auth/signin", { method: "POST", json: { name, email } });
    setToken(res.token);
    remember(res.user);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    remember(null);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api<AppConfig>("/config");
        if (!alive) return;
        setConfig(cfg);
        if (cfg.demo_mode) {
          const list = await api<UserLite[]>("/personas");
          if (alive) setPersonas(list);
        }
        const cached = (() => {
          try {
            return JSON.parse(window.localStorage.getItem(USER_KEY) || "null") as UserLite | null;
          } catch {
            return null;
          }
        })();
        let restored = false;
        if (getToken() && cached) {
          try {
            const me = await api<{ user: UserLite }>("/me");
            if (alive) setUser(me.user);
            restored = true;
          } catch {
            setToken(null);
          }
        }
        if (!restored && cfg.demo_mode) {
          await signInAs(cached?.persona || DEFAULT_PERSONA);
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't load Sidequest.", "error");
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [signInAs, toast]);

  const value = useMemo(
    () => ({ config, user, personas, ready, signInAs, signIn, signOut, toast }),
    [config, user, personas, ready, signInAs, signIn, signOut, toast],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 left-4 right-4 z-50 flex flex-col items-start gap-2 sm:left-auto sm:right-6 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast max-w-sm rounded border-2 px-4 py-3 text-[15px] font-semibold shadow-[0_4px_0_var(--ink)] ${
              t.tone === "error"
                ? "border-stamp bg-white text-stamp"
                : t.tone === "money"
                  ? "border-money bg-money text-white"
                  : "border-ink bg-stock text-ink"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
