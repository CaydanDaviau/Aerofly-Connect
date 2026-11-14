// ATIS helpers: METAR decoding (from the raw text, so no dependence on a JSON schema) + change signature for the auto letter bump.
export function parseMetar(raw) {
  raw = String(raw || "").trim().split("\n")[0].replace(/\s+/g, " ");
  if (!raw) return null;
  const tk = raw.split(" ");
  const w = { raw, wind: null, vis_m: null, cavok: false, temp: null, dew: null, qnh: null, clouds: [] };
  let wi = -1;
  tk.forEach((t, i) => {
    let m;
    if (wi < 0 && (m = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(t))) {
      const f = m[4] === "MPS" ? 1.944 : 1;
      w.wind = { dir: m[1] === "VRB" ? null : Number(m[1]), spd: Math.round(Number(m[2]) * f), gst: m[3] ? Math.round(Number(m[3]) * f) : null };
      wi = i;
    } else if (t === "CAVOK") { w.cavok = true; w.vis_m = 9999; }
    else if (wi >= 0 && w.vis_m === null && /^\d{4}$/.test(t)) w.vis_m = Number(t);
    else if (wi >= 0 && w.vis_m === null && (m = /^(\d+)(?:\/(\d+))?SM$/.exec(t))) w.vis_m = Math.round((m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) * 1609);
    else if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(t))) { const n = s => (s ? (s[0] === "M" ? -1 : 1) * Number(s.replace("M", "")) : null); w.temp = n(m[1]); w.dew = n(m[2]); }
    else if ((m = /^Q(\d{4})$/.exec(t))) w.qnh = Number(m[1]);
    else if ((m = /^A(\d{4})$/.exec(t))) w.qnh = Math.round(Number(m[1]) / 100 * 33.8639);
    else if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3})/.exec(t))) w.clouds.push({ cover: m[1], base_ft: Number(m[2]) * 100 });
  });
  return w;
}

// Changes that earn a new ATIS letter: QNH, wind (30 deg / 5 kt steps), visibility band, ceiling band.
export function wxSig(w) {
  if (!w) return "";
  const wd = w.wind ? (w.wind.dir === null ? "V" : Math.round(w.wind.dir / 30) % 12) + "/" + Math.round(w.wind.spd / 5) : "-";
  const vb = w.vis_m === null ? "-" : w.vis_m >= 9999 ? "10" : w.vis_m < 1500 ? "a" : w.vis_m < 5000 ? "b" : "c";
  const ce = w.clouds.filter(c => c.cover === "BKN" || c.cover === "OVC" || c.cover === "VV").map(c => c.base_ft).sort((a, b) => a - b)[0];
  const cb = ce === undefined ? "-" : ce < 1000 ? "a" : ce < 3000 ? "b" : "c";
  return [w.qnh, wd, vb, cb].join("|");
}

export const nextLetter = l => String.fromCharCode(((String(l || "A").charCodeAt(0) - 64) % 26) + 65);
