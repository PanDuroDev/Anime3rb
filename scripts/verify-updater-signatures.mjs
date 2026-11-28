import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdaterPublicKey, verifyUpdaterSignature } from "./updater-signatures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(repoRoot, process.argv[2] ?? "dist");
const version = process.env.VERSION;
if (!version) {
  throw new Error("VERSION is required so updater signatures can be checked against the release version");
}

const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
const { keyId, publicKey } = readUpdaterPublicKey(config.plugins?.updater?.pubkey);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(artifactRoot);
for (const suffix of [".exe.sig", ".msi.sig"]) {
  const signaturePath = files.find((path) => path.toLowerCase().endsWith(suffix));
  if (!signaturePath) {
    throw new Error("Missing required Windows updater signature: *" + suffix);
  }

  const artifactPath = signaturePath.slice(0, -4);
  verifyUpdaterSignature({
    signatureFileContent: readFileSync(signaturePath, "utf8"),
    artifact: readFileSync(artifactPath),
    artifactName: basename(artifactPath),
    publicKey,
    publicKeyId: keyId,
    expectedVersion: version,
  });
  console.log("Verified " + basename(artifactPath) + " using the embedded updater public key");
}
