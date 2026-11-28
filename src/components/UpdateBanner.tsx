import { useCallback, useEffect, useState } from "react";
import { DownloadProgress, findUpdate, PendingUpdate } from "../lib/update";

const RECHECK_MS = 6 * 60 * 60 * 1000;

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${Math.max(0, Math.round(bytes))} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function UpdateBanner() {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [checkError, setCheckError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
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

  const signatureVerificationFailed =
    /signature verification failed|failed to verify (?:the )?signature|signature (?:is )?(?:invalid|mismatch|does not match)/i.test(
      error,
    );
  const percentage = progress?.finished
    ? 100
    : progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(99, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
      : null;

  const run = async () => {
    setBusy(true);
    setError("");
    setProgress(null);
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
        {error && (
          <span className="update-error">
            {signatureVerificationFailed
              ? "The update signature could not be verified. Installation was blocked for security. Anime3rb checks signatures automatically; no separate signature file is needed."
              : error}
          </span>
        )}
      </div>
      {busy && progress && !update.external && (
        <div className="update-progress">
          <div
            className={`update-progress-track${percentage === null ? " is-indeterminate" : ""}`}
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage ?? undefined}
          >
            <i style={percentage === null ? undefined : { width: `${percentage}%` }} />
          </div>
          <span className="update-progress-label">
            {percentage === null
              ? `${formatBytes(progress.downloadedBytes)} downloaded`
              : `${percentage}% · ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes ?? progress.downloadedBytes)}`}
          </span>
        </div>
      )}
      <button
        className="update-install"
        type="button"
        onClick={run}
        disabled={busy || signatureVerificationFailed}
      >
        {busy
          ? percentage === null
            ? "Downloading…"
            : `${percentage}%`
          : signatureVerificationFailed
            ? "Blocked"
            : error
              ? "Retry"
              : update.external
                ? "Download"
                : "Update now"}
      </button>
      <button className="update-later" type="button" onClick={() => setHidden(update.version)} disabled={busy}>
        Later
      </button>
    </div>
  );
}
