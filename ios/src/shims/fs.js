// config.json lives in localStorage (key "afc_file:<path>")
const K = p => "afc_file:" + p;
module.exports = {
  readFileSync(p) { const v = localStorage.getItem(K(p)); if (v == null) throw new Error("ENOENT"); return v; },
  writeFileSync(p, s) { localStorage.setItem(K(p), s); },
  mkdirSync() {},
};
