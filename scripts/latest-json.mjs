import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = "dist";
const version = process.env.VERSION;
const notes = process.env.NOTES || "";
const files = readdirSync(dir);
const installer = files.find((file) => file.endsWith(".exe"));
const signature = files.find((file) => file.endsWith(".exe.sig"));

if (!version || !installer || !signature) {
  console.error("latest.json needs VERSION, the NSIS installer, and its .sig", { version, files });
  process.exit(1);
}

const base = `https://github.com/PanDuroDev/Anime3rb/releases/download/v${version}`;
writeFileSync(
  `${dir}/latest.json`,
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: readFileSync(`${dir}/${signature}`, "utf8").trim(),
          url: `${base}/${installer}`,
        },
      },
    },
    null,
    2,
  ),
);
console.log(`latest.json -> ${version} (${installer})`);
