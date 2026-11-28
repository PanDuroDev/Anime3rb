import { createHash, createPublicKey, verify } from "node:crypto";

const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

export function readUpdaterPublicKey(encodedPublicKey) {
  const document = Buffer.from(encodedPublicKey ?? "", "base64").toString("utf8");
  const lines = document.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error("Could not decode plugins.updater.pubkey from tauri.conf.json");
  }

  const bytes = Buffer.from(lines[1].trim(), "base64");
  if (bytes.length !== 42 || bytes[0] !== 0x45 || bytes[1] !== 0x64) {
    throw new Error("plugins.updater.pubkey is not a valid Ed25519 Minisign public key");
  }

  const keyId = bytes.subarray(2, 10);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      bytes.subarray(10, 42),
    ]),
    format: "der",
    type: "spki",
  });

  return { keyId, publicKey };
}

export function verifyUpdaterSignature({
  signatureFileContent,
  artifact,
  artifactName,
  publicKey,
  publicKeyId,
  expectedVersion,
}) {
  const decoded = Buffer.from(signatureFileContent.trim(), "base64").toString("utf8");
  const lines = decoded.trim().split(/\r?\n/);
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("Invalid Minisign signature structure: " + artifactName);
  }

  const signature = Buffer.from(lines[1].trim(), "base64");
  const globalSignature = Buffer.from(lines[3].trim(), "base64");
  if (signature.length !== 74 || globalSignature.length !== 64) {
    throw new Error("Invalid Minisign signature payload: " + artifactName);
  }
  if (signature[0] !== 0x45 || signature[1] !== 0x44) {
    throw new Error("Expected a pre-hashed Minisign signature: " + artifactName);
  }

  const signatureKeyId = signature.subarray(2, 10);
  if (!signatureKeyId.equals(publicKeyId)) {
    throw new Error(
      "Signing key ID mismatch for " + artifactName +
      ": signature " + signatureKeyId.toString("hex") +
      ", app config " + publicKeyId.toString("hex") +
      ". Check TAURI_SIGNING_PRIVATE_KEY and tauri.conf.json.",
    );
  }

  const scalar = BigInt("0x" + Buffer.from(signature.subarray(42, 74)).reverse().toString("hex"));
  if (scalar >= ED25519_ORDER) {
    throw new Error("Non-canonical Ed25519 signature scalar: " + artifactName);
  }

  const digest = createHash("blake2b512").update(artifact).digest();
  if (!verify(null, digest, publicKey, signature.subarray(10, 74))) {
    throw new Error(
      "Cryptographic signature verification failed for " + artifactName +
      ". The artifact may be corrupted, or TAURI_SIGNING_PRIVATE_KEY does not correspond " +
      "to the public key embedded in tauri.conf.json. Do not disable signature verification.",
    );
  }

  const trustedComment = lines[2].slice("trusted comment: ".length);
  const globalMessage = Buffer.concat([signature.subarray(10, 74), Buffer.from(trustedComment)]);
  if (!verify(null, globalMessage, publicKey, globalSignature)) {
    throw new Error("Trusted comment signature is invalid: " + artifactName);
  }

  const signedVersion = trustedComment
    .split("\t")
    .find((part) => part.startsWith("version:"))
    ?.slice("version:".length);
  if (signedVersion !== expectedVersion) {
    throw new Error(
      artifactName + " is signed for " + (signedVersion ?? "no version") +
      ", expected " + expectedVersion,
    );
  }

  return { signedVersion, trustedComment };
}
