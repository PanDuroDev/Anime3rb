import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readUpdaterPublicKey, verifyUpdaterSignature } from "./updater-signatures.mjs";

const { publicKey: generatedPublicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyDer = generatedPublicKey.export({ format: "der", type: "spki" });
const keyId = randomBytes(8);
const publicKeyBytes = Buffer.concat([
  Buffer.from([0x45, 0x64]),
  keyId,
  publicKeyDer.subarray(-32),
]);
const publicKeyDocument = [
  "untrusted comment: minisign public key",
  publicKeyBytes.toString("base64"),
].join("\n");
const encodedPublicKey = Buffer.from(publicKeyDocument).toString("base64");
const parsedKey = readUpdaterPublicKey(encodedPublicKey);

const payload = Buffer.from("Anime3rb updater signature verifier regression test");
const version = "0.2.2";
const trustedComment = "timestamp:1795877613\tfile:updater-test\tversion:" + version;
const digest = createHash("blake2b512").update(payload).digest();
const detachedSignature = sign(null, digest, privateKey);
const signatureBytes = Buffer.concat([
  Buffer.from([0x45, 0x64]),
  keyId,
  detachedSignature,
]);
const globalSignature = sign(
  null,
  Buffer.concat([detachedSignature, Buffer.from(trustedComment)]),
  privateKey,
);
const signatureDocument = [
  "untrusted comment: signature from tauri secret key",
  signatureBytes.toString("base64"),
  "trusted comment: " + trustedComment,
  globalSignature.toString("base64"),
].join("\n");
const signatureFileContent = Buffer.from(signatureDocument).toString("base64");

const verified = verifyUpdaterSignature({
  signatureFileContent,
  artifact: payload,
  artifactName: "updater-test",
  publicKey: parsedKey.publicKey,
  publicKeyId: parsedKey.keyId,
  expectedVersion: version,
});
assert.equal(verified.signedVersion, version);

assert.throws(
  () => verifyUpdaterSignature({
    signatureFileContent,
    artifact: Buffer.from("tampered payload"),
    artifactName: "updater-test",
    publicKey: parsedKey.publicKey,
    publicKeyId: parsedKey.keyId,
    expectedVersion: version,
  }),
  /Cryptographic signature verification failed/,
);
assert.throws(
  () => verifyUpdaterSignature({
    signatureFileContent,
    artifact: payload,
    artifactName: "updater-test",
    publicKey: parsedKey.publicKey,
    publicKeyId: parsedKey.keyId,
    expectedVersion: "9.9.9",
  }),
  /signed for 0\.2\.2, expected 9\.9\.9/,
);

console.log("Minisign verifier tests passed (valid signature, modified payload, signed version).");
