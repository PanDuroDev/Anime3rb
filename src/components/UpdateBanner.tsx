import { useCallback, useEffect, useState } from "react";
import { findUpdate, PendingUpdate } from "../lib/update";

const RECHECK_MS = 6 * 60 * 60 * 1000;

export default function UpdateBanner() {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [checkError, setCheckError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState<string | null>(null);

  const scan = useCallback(async () => {
    try {
      setUpdate(await findUpdate());
      setCheckError("");
    } catch (cause) {
      setUpdate(null);
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    scan();
    const timer = setInterval(scan, RECHECK_MS);
    return () => clearInterval(timer);
  }, [scan]);

  const retry = () => {
    setHidden(null);
    scan();
  };

  if (checkError) {
    if (hidden === "error") return null;
    return (
      <div className="update-banner" role="status">
        <div className="update-text">
          <strong>Update check failed</strong>
          <span className="update-error">{checkError}</span>
        </div>
        <button className="update-install" type="button" onClick={retry}>
          Retry
        </button>
        <button className="update-later" type="button" onClick={() => setHidden("error")}>
          Later
        </button>
      </div>
    );
  }

  if (!update || hidden === update.version) return null;

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await update.install(setProgress);
      if (update.external) setUpdate(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <strong>Update {update.version}</strong>
        <span>{update.external ? "Download the new APK to install it." : "A newer version is ready."}</span>
        {error && <span className="update-error">{error}</span>}
      </div>
      <button className="update-install" type="button" onClick={run} disabled={busy}>
        {busy ? (progress === null ? "Downloading…" : `${Math.round(progress * 100)}%`) : update.external ? "Download" : "Update now"}
      </button>
      <button className="update-later" type="button" onClick={() => setHidden(update.version)} disabled={busy}>
        Later
      </button>
    </div>
  );
}
