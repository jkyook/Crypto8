import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { AUTH_CLEARED_EVENT, AUTH_UPDATED_EVENT, getSession, type AuthSession } from "../lib/api";

type SessionContextValue = {
  session: AuthSession | null;
  setSession: Dispatch<SetStateAction<AuthSession | null>>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

type SessionProviderProps = {
  children: ReactNode;
};

export function SessionProvider({ children }: SessionProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(getSession());

  useEffect(() => {
    const sync = (): void => {
      setSession(getSession());
    };
    sync();
    window.addEventListener(AUTH_CLEARED_EVENT, sync);
    window.addEventListener(AUTH_UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener(AUTH_CLEARED_EVENT, sync);
      window.removeEventListener(AUTH_UPDATED_EVENT, sync);
    };
  }, []);

  const value = useMemo(() => ({ session, setSession }), [session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSessionContext must be used within SessionProvider");
  }
  return value;
}
