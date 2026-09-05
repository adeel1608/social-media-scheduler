import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { loadTurnstile, type TurnstileApi } from "../lib/turnstile";

export interface TurnstileWidgetHandle {
  reset(): void;
}

interface TurnstileWidgetProperties {
  siteKey: string;
  onTokenChange(token: string): void;
}

export const TurnstileWidget = forwardRef<
  TurnstileWidgetHandle,
  TurnstileWidgetProperties
>(function TurnstileWidget({ siteKey, onTokenChange }, reference) {
  const containerReference = useRef<HTMLDivElement>(null);
  const apiReference = useRef<TurnstileApi | null>(null);
  const widgetIdReference = useRef<string | null>(null);
  const [error, setError] = useState("");
  const labelId = useId();
  const statusId = useId();

  const reset = () => {
    onTokenChange("");
    setError("");
    if (apiReference.current && widgetIdReference.current) {
      try {
        apiReference.current.reset(widgetIdReference.current);
      } catch {
        setError(
          "The security challenge could not reset. Reload and try again.",
        );
      }
    }
  };

  useImperativeHandle(reference, () => ({ reset }));

  useEffect(() => {
    let active = true;
    if (!siteKey) {
      onTokenChange("");
      setError("Owner login security is not configured for this installation.");
      return () => {
        active = false;
      };
    }

    void loadTurnstile()
      .then((api) => {
        if (!active || !containerReference.current) return;
        apiReference.current = api;
        widgetIdReference.current = api.render(containerReference.current, {
          sitekey: siteKey,
          action: "owner_login",
          callback(token) {
            if (!active) return;
            setError("");
            onTokenChange(token);
          },
          "expired-callback"() {
            if (!active) return;
            onTokenChange("");
            setError(
              "The security challenge expired. Please complete it again.",
            );
          },
          "timeout-callback"() {
            if (!active) return;
            onTokenChange("");
            setError("The security challenge timed out. Please try again.");
          },
          "error-callback"() {
            if (!active) return;
            onTokenChange("");
            setError(
              "The security challenge failed to verify. Please try again.",
            );
          },
        });
      })
      .catch(() => {
        if (!active) return;
        onTokenChange("");
        setError(
          "The security challenge could not be loaded. Please try again.",
        );
      });

    return () => {
      active = false;
      if (apiReference.current && widgetIdReference.current) {
        apiReference.current.remove(widgetIdReference.current);
      }
      apiReference.current = null;
      widgetIdReference.current = null;
    };
  }, [onTokenChange, siteKey]);

  return (
    <div
      className="turnstile-field"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={statusId}
    >
      <span id={labelId} className="turnstile-label">
        Security verification
      </span>
      <div ref={containerReference} className="turnstile-widget" />
      <span id={statusId} className="turnstile-status">
        Complete the Cloudflare security challenge before requesting a sign-in
        link.
      </span>
      {error && (
        <span className="turnstile-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
});
