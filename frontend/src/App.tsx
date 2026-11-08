import { lazy, Suspense, useEffect, useState } from "react";

import { LangProvider } from "./i18n";
import { OwnerApp } from "./shell/OwnerApp";
import { Loading } from "./ui/Loading";
import { ToastProvider } from "./ui/Toast";

// The customer's page is its own small download; a customer never loads the owner's screens.
const PayPage = lazy(() => import("./pages/PayPage").then((m) => ({ default: m.PayPage })));

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const payMatch = hash.match(/^#\/pay\/([\w-]+)/);
  return (
    <LangProvider>
      <ToastProvider>
        {payMatch ? (
          <Suspense
            fallback={
              <div className="paypage">
                <Loading shape="cards" />
              </div>
            }
          >
            <PayPage token={payMatch[1]} />
          </Suspense>
        ) : (
          <OwnerApp hash={hash} />
        )}
      </ToastProvider>
    </LangProvider>
  );
}
