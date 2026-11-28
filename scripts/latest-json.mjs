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
const findFile = (suffix) => files.find((file) => file.toLowerCase().endsWith(suffix));
const nsisInstaller = findFile(".exe");
const msiInstaller = findFile(".msi");
const siblingSignature = (installer) =>
  installer && files.find((file) => file.toLowerCase() === `${installer}.sig`.toLowerCase());
const nsisSignature = siblingSignature(nsisInstaller);
const msiSignature = siblingSignature(msiInstaller);

if (!version || !nsisInstaller || !nsisSignature || !msiInstaller || !msiSignature) {
  console.error("latest.json needs VERSION plus the NSIS and MSI installers and their .sig files", {
    version,
    files,
  });
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
        // Prefer installer-specific targets. Keep the generic target as a compatibility fallback.
        "windows-x86_64-nsis": {
          signature: readFileSync(nsisSignature, "utf8").trim(),
          url: `${base}/${basename(nsisInstaller)}`,
        },
        "windows-x86_64": {
          signature: readFileSync(nsisSignature, "utf8").trim(),
          url: `${base}/${basename(nsisInstaller)}`,
        },
        "windows-x86_64-msi": {
          signature: readFileSync(msiSignature, "utf8").trim(),
          url: `${base}/${basename(msiInstaller)}`,
        },
      },
    },
    null,
    2,
  ),
);
console.log(`latest.json -> ${version} (NSIS: ${basename(nsisInstaller)}, MSI: ${basename(msiInstaller)})`);
