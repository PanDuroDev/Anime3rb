import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src-tauri/android/MainActivity.kt");
const configPath = resolve(root, "src-tauri/tauri.conf.json");
const androidMain = resolve(root, "src-tauri/gen/android/app/src/main");

const config = JSON.parse(await readFile(configPath, "utf8"));
const identifier = config.identifier;

if (typeof identifier !== "string" || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) {
  throw new Error(`Invalid Android application identifier: ${identifier}`);
}

try {
  await access(androidMain);
} catch {
  throw new Error("Android project is missing. Run 'npm run android:init' first.");
}

const destination = resolve(
  androidMain,
  "java",
  ...identifier.split("."),
  "MainActivity.kt"
);

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);

console.log(`Applied Android system-bar handling to ${destination}`);
