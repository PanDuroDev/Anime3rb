import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(repoRoot, process.argv[2] ?? "dist");
const version = process.env.VERSION;
if (!version) {
  throw new Error("VERSION is required so updater signatures can be checked against the release version");
}
const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));

const publicKeyText = Buffer.from(config.plugins?.updater?.pubkey ?? "", "base64").toString("utf8");
const publicKeyLines = publicKeyText.trim().split(/\r?\n/);
if (publicKeyLines.length < 2) {
  throw new Error("Could not decode the updater public key from tauri.conf.json");
}

const publicKeyBytes = Buffer.from(publicKeyLines[1].trim(), "base64");
if (
  publicKeyBytes.length !== 42 ||
  publicKeyBytes[0] !== 0x45 ||
  publicKeyBytes[1] !== 0x64
) {
  throw new Error("The updater public key in tauri.conf.json is not a valid Ed25519 Minisign key");
}

const publicKeyId = publicKeyBytes.subarray(2, 10);
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    publicKeyBytes.subarray(10, 42),
  ]),
  format: "der",
  type: "spki",
});
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

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
    throw new Error(`Missing required Windows updater signature: *${suffix}`);
  }

  const artifactPath = signaturePath.slice(0, -4);
  const encodedSignature = readFileSync(signaturePath, "utf8").trim();
  const decodedSignature = Buffer.from(encodedSignature, "base64").toString("utf8");
  const lines = decodedSignature.trim().split(/\r?\n/);
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) {
    throw new Error(`Invalid Minisign signature structure: ${basename(signaturePath)}`);
  }

  const signature = Buffer.from(lines[1].trim(), "base64");
  const globalSignature = Buffer.from(lines[3].trim(), "base64");
  if (signature.length !== 74 || globalSignature.length !== 64) {
    throw new Error(`Invalid Minisign signature payload: ${basename(signaturePath)}`);
  }
  if (signature[0] !== 0x45 || signature[1] !== 0x44) {
    throw new Error(`Expected a pre-hashed Minisign signature: ${basename(signaturePath)}`);
  }
  const signatureKeyId = signature.subarray(2, 10);
  if (!signatureKeyId.equals(publicKeyId)) {
    throw new Error(
      `Signing key ID mismatch for ${basename(artifactPath)}: signature ${signatureKeyId.toString("hex")}, app config ${publicKeyId.toString("hex")}. Check the GitHub Actions TAURI_SIGNING_PRIVATE_KEY secret.`,
    );
  }

  const scalar = BigInt(`0x${Buffer.from(signature.subarray(42, 74)).reverse().toString("hex")}`);
  if (scalar >= ED25519_ORDER) {
    throw new Error(`Non-canonical Ed25519 signature scalar: ${basename(signaturePath)}`);
  }

  const artifact = readFileSync(artifactPath);
  const digest = createHash("blake2b512").update(artifact).digest();
  if (!verify(null, digest, publicKey, signature.subarray(10, 74))) {
    throw new Error(
      `Cryptographic signature verification failed for ${basename(artifactPath)}. The artifact may be corrupted, or the GitHub Actions TAURI_SIGNING_PRIVATE_KEY secret does not contain the private key paired with the public key embedded in tauri.conf.json. Do not disable signature verification.`,
    );
  }

  const trustedComment = lines[2].slice("trusted comment: ".length);
  const globalMessage = Buffer.concat([signature.subarray(10, 74), Buffer.from(trustedComment)]);
  if (!verify(null, globalMessage, publicKey, globalSignature)) {
    throw new Error(`Trusted comment signature is invalid: ${basename(signaturePath)}`);
  }

  if (version) {
    const signedVersion = trustedComment
      .split("\t")
      .find((part) => part.startsWith("version:"))
      ?.slice("version:".length);
    if (signedVersion !== version) {
      throw new Error(
        `${basename(artifactPath)} is signed for ${signedVersion ?? "no version"}, expected ${version}`,
      );
    }
  }

  console.log(`Verified ${basename(artifactPath)} using the embedded updater public key`);
}
