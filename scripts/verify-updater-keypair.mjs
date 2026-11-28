import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdaterPublicKey, verifyUpdaterSignature } from "./updater-signatures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
const version = process.env.VERSION || config.version;
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is not available to the Windows signing job");
}

const tauriCli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(tauriCli)) {
  throw new Error("Tauri CLI was not installed. Run npm ci before the updater key check.");
}

const { keyId, publicKey } = readUpdaterPublicKey(config.plugins?.updater?.pubkey);
const tempDirectory = mkdtempSync(join(tmpdir(), "anime3rb-updater-keycheck-"));
const probePath = join(tempDirectory, "updater-keypair-probe.txt");
const signaturePath = probePath + ".sig";

try {
  writeFileSync(probePath, "Anime3rb updater signing-key verification\nversion=" + version + "\n");

  // Use Tauri's own signer and the exact secrets used by the build.
  // The probe is temporary; only its public signature is inspected below.
  const result = spawnSync(
    process.execPath,
    [tauriCli, "signer", "sign", "--app-version", version, probePath],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error("Tauri signer could not run: " + result.error.message);
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error("Tauri signer failed to sign a temporary probe. Check the private-key secret and password. " + details);
  }
  if (!existsSync(signaturePath)) {
    throw new Error("Tauri signer completed without creating the probe signature");
  }

  try {
    verifyUpdaterSignature({
      signatureFileContent: readFileSync(signaturePath, "utf8"),
      artifact: readFileSync(probePath),
      artifactName: basename(probePath),
      publicKey,
      publicKeyId: keyId,
      expectedVersion: version,
    });
  } catch (error) {
    throw new Error(
      "The configured TAURI_SIGNING_PRIVATE_KEY does not match the public key embedded in tauri.conf.json. " +
      "Restore the original matching key pair; changing the public key requires a manual reinstall for existing users. " +
      (error instanceof Error ? error.message : String(error)),
    );
  }

  console.log("Updater signing key matches tauri.conf.json (key ID " + keyId.toString("hex") + ")");
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
