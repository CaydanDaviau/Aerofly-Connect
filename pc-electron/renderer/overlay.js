(function () {
  const root = document.getElementById("root");
  let S = null, open = false, autoExp = false, lastPend = "", lastAlert = "", collapseT = null, atisOpen = false, atisWhich = "", atisT = null, holdT = null, held = false;
  const T = (en, pt) => (S && S.lang === "pt" ? pt : en);
  function h(tag, a, ...kids) {
    const e = document.createElement(tag);
    for (const k in a || {}) { if (k === "class") e.className = a[k]; else if (k.startsWith("on")) e.addEventListener(k.slice(2), a[k]); else if (a[k] !== false && a[k] != null) e.setAttribute(k, a[k] === true ? "" : a[k]); }
    for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  }

  // ---- drag (header and bubble); a click without movement is a tap ----
  function dragable(el, onTap) {
    let sx, sy, moved, down = false;
    el.addEventListener("mousedown", e => { if (e.target.closest("button,input")) return; down = true; moved = false; sx = e.screenX; sy = e.screenY; window.ov.drag("start", sx, sy); });
    window.addEventListener("mousemove", e => { if (!down) return; if (Math.abs(e.screenX - sx) + Math.abs(e.screenY - sy) > 4) moved = true; if (moved) window.ov.drag("move", e.screenX, e.screenY); });
    window.addEventListener("mouseup", () => { if (!down) return; down = false; window.ov.drag("end"); if (!moved && onTap) onTap(); });
  }

  // ---- bubble ----
  const bubble = h("div", { class: "bubble" }, "ATC"); dragable(bubble, () => { open = true; autoExp = false; draw(); });

  // ---- panel parts ----
  const ct = h("span", { class: "ct" }), minB = h("button", { class: "hd2", onclick: () => { open = false; autoExp = false; draw(); } }, "–");
  const hd = h("div", { class: "hd" }, h("b", {}, "ATC"), ct, minB); dragable(hd, null);
  const ta = h("div", { class: "ta" });
  const msg = h("div", { class: "msg" }), more = h("div", { class: "more" });
  const bW = h("button", { class: "ok", onclick: () => S.pending && window.ov.reply(S.pending.id, "wilco") }, "Wilco");
  const bU = h("button", { class: "no", onclick: () => S.pending && window.ov.reply(S.pending.id, "unable") }, "");
  const ans = h("div", { class: "row" }, bW, bU);
  const reqs = {}; const grid = h("div", { class: "g2" });
  for (const [k, en, pt] of [["clearance", "Clearance", "Autorização"], ["taxi", "Taxi", "Táxi"], ["takeoff", "Take off", "Decolagem"], ["land", "Landing", "Pouso"]]) {
    reqs[k] = h("button", { onclick: () => window.ov.request(k) }); reqs[k].dataset.en = en; reqs[k].dataset.pt = pt; grid.append(reqs[k]);
  }
  const bE = h("button", { class: "no", onclick: () => window.ov.emergency() }), bA = h("button", { onclick: toggleAtis });
  const rowEA = h("div", { class: "row" }, bE, bA);
  const aHead = h("div", { class: "row" }), aTitle = h("div", { class: "fr tt" }), aSwap = h("button", { class: "fix", onclick: () => { atisWhich = atisWhich === "dep" ? "arr" : "dep"; fetchAtis(); } }, "⇄");
  aHead.append(aTitle, aSwap); const aBox = h("div", { class: "atis" });
  const atisWrap = h("div", {}, aHead, aBox);
  // frequency row
  const fIn = h("input", { class: "fr", placeholder: "ALL", autocomplete: "off", spellcheck: "false", maxlength: "7", onfocus: () => window.ov.typing(true), onblur: () => { window.ov.typing(false); window.ov.freq("set", fIn.value); },
    onkeydown: e => { if (e.key === "Enter") { fIn.blur(); } } });
  function holdBtn(label, dir) {
    const b = h("button", { class: "fix" }, label);
    b.addEventListener("mousedown", () => { held = false; clearTimeout(holdT); const rep = () => { held = true; window.ov.freq("step", { dir, khz: 1000 }); holdT = setTimeout(rep, 220); }; holdT = setTimeout(rep, 450); });
    const end = () => { clearTimeout(holdT); };
    b.addEventListener("mouseup", () => { end(); if (!held) window.ov.freq("step", { dir, khz: 25 }); });
    b.addEventListener("mouseleave", end); return b;
  }
  const bAll = h("button", { class: "fix", onclick: () => window.ov.freq("set", "") }, "ALL");
  const fRow = h("div", { class: "row" }, bAll, holdBtn("‹", -1), fIn, holdBtn("›", 1));
  const quick = h("div", { class: "q" });
  // chat
  const cIn = h("input", { maxlength: "200", autocomplete: "off", spellcheck: "false", onfocus: () => window.ov.typing(true), onblur: () => window.ov.typing(false), onkeydown: e => { if (e.key === "Enter") sendChat(); } });
  const bS = h("button", { class: "fix", onclick: sendChat }, "➤"); const cRow = h("div", { class: "row" }, cIn, bS);
  const st = h("div", { class: "st" });
  const panel = h("div", { class: "panel" }, hd, ta, msg, more, ans, grid, rowEA, atisWrap, h("div", { class: "sec", id: "fsec" }), fRow, quick, cRow, st);
  const fsec = panel.querySelector("#fsec");

  function sendChat() { const v = cIn.value.trim(); if (!v) return; window.ov.chat(v); cIn.value = ""; cIn.blur(); }
  function curIcao() { return S && S[atisWhich] ? S[atisWhich] : ""; }
  function fetchAtis() { window.ov.atis(curIcao()); draw(); }
  function toggleAtis() {
    atisOpen = !atisOpen; clearInterval(atisT);
    if (atisOpen) { if (!atisWhich) atisWhich = S.air ? "arr" : "dep"; fetchAtis(); atisT = setInterval(fetchAtis, 60000); }
    draw();
  }

  function draw() {
    if (!S) return;
    root.replaceChildren(open ? panel : bubble);
    const p = S.pending, hot = !!p || !!S.alert;
    bubble.className = "bubble" + (S.alert ? " red" : hot ? " hot" : "");
    ct.textContent = S.contact ? T("Controller: ", "Controlador: ") + S.contact : "";
    ta.style.display = S.alert ? "" : "none"; ta.textContent = S.alert;
    msg.style.display = p ? "" : "none"; ans.style.display = p ? "" : "none"; more.style.display = p && S.more ? "" : "none";
    if (p) { msg.textContent = p.text; msg.className = "msg" + (p.urgent ? " u" : ""); }
    more.textContent = S.more ? "+" + S.more + T(" more", " mais") : "";
    bU.textContent = T("Unable", "Impossível");
    // phase buttons: shown only when they fit (like Android); hidden grid when ATIS open
    for (const k in reqs) { const on = S.offers.includes(k); reqs[k].textContent = reqs[k].dataset[S.lang === "pt" ? "pt" : "en"]; reqs[k].disabled = !on; reqs[k].style.display = on ? "" : "none"; }
    grid.style.display = !atisOpen && S.offers.length ? "" : "none";
    bE.textContent = S.emergency ? T("Cancel Mayday", "Cancelar Mayday") : S.armed ? T("Confirm Mayday", "Confirmar Mayday") : T("Emergency ×2", "Emergência ×2");
    bA.textContent = atisOpen ? T("Back", "Voltar") : "ATIS" + (S.atis && S.atis.letter ? " " + S.atis.letter : "");
    atisWrap.style.display = atisOpen ? "" : "none";
    if (atisOpen) { aTitle.textContent = "ATIS " + (curIcao() || "-"); aBox.textContent = S.atis && S.atis.icao === curIcao() && S.atis.text ? S.atis.text : "…"; }
    fsec.textContent = "FREQ"; if (document.activeElement !== fIn) fIn.value = S.freq || "";
    fIn.placeholder = "ALL"; bAll.className = "fix" + (S.freq ? "" : " ok");
    quick.replaceChildren(...S.quick.map(q => h("button", { onclick: () => window.ov.freq("set", q.freq) }, q.pos + " " + q.freq)));
    st.textContent = S.status; st.className = "st" + (S.status ? " f" : "");
    cIn.placeholder = T("Message to ATC", "Mensagem ao ATC");
  }

  function onState(s) {
    S = s; if (!s) return;
    const pid = s.pending ? s.pending.id : "", al = s.alert || "";
    // a new ATC message or advisory opens the panel by itself, 6 s after the answer it folds again
    if ((pid && pid !== lastPend) || (al && al !== lastAlert)) { if (!open) { open = true; autoExp = true; } clearTimeout(collapseT); }
    if (autoExp && !pid && !al && lastPend && !collapseT) collapseT = setTimeout(() => { collapseT = null; if (autoExp) { open = false; autoExp = false; draw(); } }, 6000);
    lastPend = pid; lastAlert = al; draw();
  }

  new ResizeObserver(() => window.ov.size(Math.ceil(root.offsetWidth), Math.ceil(root.offsetHeight))).observe(root);
  window.ov.onState(onState); window.ov.ready();
})();
