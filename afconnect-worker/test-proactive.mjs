import { TEST } from "./src/index.js";
import { parseMetar } from "./src/atis.js";
const src = await import("node:fs").then(f => f.readFileSync(new URL("./src/index.js", import.meta.url), "utf8"));
const T = (n, v) => console.log("proactive " + n + ":", v ? "PASS" : "FAIL");
// pure helpers pulled from the source (not exported)
const grab = n => new RegExp("const " + n + " = [^\\n]*\\n").exec(src)[0];
const code = ["TRANS_ALT", "pad3", "cap1", "windSay", "FACE", "faceSay"].map(grab).join("");
const f = new Function(code + "return { windSay, faceSay };")();
const w = parseMetar("SBGR 251200Z 23004KT 9999 FEW030 25/18 Q1015");
T("wind", f.windSay(w, "en") === "230 degrees 4 knots");
T("wind pt", f.windSay(w, "pt") === "230 graus 4 nós");
T("gust", f.windSay(parseMetar("SBGR 251200Z 18012G25KT 9999 Q1015"), "en") === "180 degrees 12 knots gusting 25");
T("calm", f.windSay(parseMetar("SBGR 251200Z 00000KT 9999 Q1015"), "en") === "calm");
T("face 27", f.faceSay("27L", "en") === "west"); T("face 09", f.faceSay("09", "pt") === "leste"); T("qnh", w.qnh === 1015);
