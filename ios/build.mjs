// Builds ios/www: the PC renderer + overlay, adapted for the phone, and the bundled host (core + shims).
import { build } from "esbuild";
import fs from "fs";
const R = "../pc-electron/renderer", out = "www";
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out + "/assets", { recursive: true });
const sh = n => new URL("./src/shims/" + n, import.meta.url).pathname;
await build({ entryPoints: ["src/host.js"], bundle: true, outfile: out + "/host.bundle.js", format: "iife", target: "es2020", logLevel: "warning",
  alias: { net: sh("empty.js"), dgram: sh("empty.js"), fs: sh("fs.js"), path: sh("path.js"), crypto: sh("crypto.js"), ws: sh("empty.js") } });
function patch(src, pairs) { let s = fs.readFileSync(src, "utf8"); for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error("patch target missing in " + src + ": " + a.slice(0, 50)); s = s.split(a).join(b); } return s; }
fs.writeFileSync(out + "/app.js", patch(R + "/app.js", [
  ["../assets/", "assets/"],
  ['["udp", t("Aerofly on this PC", "Aerofly neste PC")], ', ""],
  ['" PC"', '" iOS"'],
]));
fs.writeFileSync(out + "/app.css", patch(R + "/app.css", [["../assets/", "assets/"]]));
for (const f of ["overlay.js", "overlay.css"]) fs.copyFileSync(R + "/" + f, out + "/" + f);
fs.copyFileSync("../pc-electron/core/voice.js", out + "/voice.js");
for (const f of fs.readdirSync("www-src")) fs.copyFileSync("www-src/" + f, out + "/" + f);
for (const f of ["bg_start.jpg", "bg_pilot.jpg", "bg_settings.png", "logo.png"]) fs.copyFileSync("../pc-electron/assets/" + f, out + "/assets/" + f);
console.log("www built");
