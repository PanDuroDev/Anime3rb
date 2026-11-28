import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = "dist";
const version = process.env.VERSION;
const notes = process.env.NOTES || "";

// download-artifact keeps the bundle folders (nsis/, msi/), so look through them.
const walk = (path) =>
  readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? walk(child) : [child];
  });

const files = walk(dir);
const installer = files.find((file) => file.endsWith(".exe"));
const signature = files.find((file) => file.endsWith(".exe.sig"));

if (!version || !installer || !signature) {
  console.error("latest.json needs VERSION, the NSIS installer, and its .sig", { version, files });
  process.exit(1);
}

const base = `https://github.com/PanDuroDev/Anime3rb/releases/download/v${version}`;
writeFileSync(
  join(dir, "latest.json"),
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: readFileSync(signature, "utf8").trim(),
          url: `${base}/${basename(installer)}`,
        },
      },
    },
    null,
    2,
  ),
);
console.log(`latest.json -> ${version} (${basename(installer)})`);
