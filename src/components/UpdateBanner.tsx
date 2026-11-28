import { useEffect, useState } from "react";
import { findUpdate, PendingUpdate } from "../lib/update";

export default function UpdateBanner() {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    findUpdate()
      .then((found) => live && setUpdate(found))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!update) return null;

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
      <button className="update-later" type="button" onClick={() => setUpdate(null)} disabled={busy}>
        Later
      </button>
    </div>
  );
}
