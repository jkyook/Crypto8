import "./polyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import { AddressType, type AuthProviderType } from "@phantom/browser-sdk";
import { PhantomProvider } from "@phantom/react-sdk";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { PortfolioProvider } from "./contexts/PortfolioContext";
import { SessionProvider } from "./contexts/SessionContext";
import "./styles.css";

const appId = import.meta.env.VITE_PHANTOM_APP_ID ?? "";
const providers: AuthProviderType[] = appId ? ["google", "apple", "phantom", "injected"] : ["injected"];
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const redirectUrl = `${window.location.origin}${basePath}`;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PhantomProvider
      config={{
        appId,
        providers,
        addressTypes: [AddressType.solana, AddressType.ethereum],
        authOptions: {
          redirectUrl
        }
      }}
    >
      <SessionProvider>
        <PortfolioProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </PortfolioProvider>
      </SessionProvider>
    </PhantomProvider>
  </React.StrictMode>
);
