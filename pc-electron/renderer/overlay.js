(function () {
  const root = document.getElementById("root");
  let voiceOn = true; try { voiceOn = localStorage.getItem("afc_voice") !== "0"; } catch (e) {}
  let ptt = null, lastVoice = null, actx = null, rxs = {}, hint = { text: "", until: 0 };
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
  const volB = h("button", { class: "hd2", onclick: () => { voiceOn = !voiceOn; try { localStorage.setItem("afc_voice", voiceOn ? "1" : "0"); } catch (e) {} if (!voiceOn) for (const k in rxs) delete rxs[k]; draw(); } }, "");
  const hd = h("div", { class: "hd" }, h("b", {}, "ATC"), ct, volB, minB); dragable(hd, null);
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
  // push to talk: hold the button, release to end. Replay plays the last transmission (heard or sent) from memory, nothing is sent again.
  const bPtt = h("button", { class: "ptt" }, ""), bRep = h("button", { class: "fix2", disabled: true, onclick: () => replay() }, "↺");
  bPtt.addEventListener("mousedown", e => { e.preventDefault(); pttStart(); });
  window.addEventListener("mouseup", () => pttEnd());
  const pttRow = h("div", { class: "row" }, bPtt, bRep);
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
  const panel = h("div", { class: "panel" }, hd, ta, msg, more, ans, grid, rowEA, atisWrap, pttRow, h("div", { class: "sec", id: "fsec" }), fRow, quick, cRow, st);
  const fsec = panel.querySelector("#fsec");

  function sendChat() { const v = cIn.value.trim(); if (!v) return; window.ov.chat(v); cIn.value = ""; cIn.blur(); }
  function curIcao() { return S && S[atisWhich] ? S[atisWhich] : ""; }
  function fetchAtis() { window.ov.atis(curIcao()); draw(); }
  function toggleAtis() {
    atisOpen = !atisOpen; clearInterval(atisT);
    if (atisOpen) { if (!atisWhich) atisWhich = S.air ? "arr" : "dep"; fetchAtis(); atisT = setInterval(fetchAtis, 60000); }
    draw();
  }


  // ---------- live voice ----------
  const say = (text, ms = 3000) => { hint = { text, until: Date.now() + ms }; draw(); setTimeout(draw, ms + 50); };
  function ac() { if (!actx) { try { actx = new AudioContext(); } catch (e) {} } if (actx && actx.state === "suspended") actx.resume(); return actx; }
  // radio sound: band-pass 420-2800 Hz, a little gain, short static burst at the end (same as the radar page)
  function chain(c) { const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 420; const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2800; const g = c.createGain(); g.gain.value = 1.6; hp.connect(lp); lp.connect(g); g.connect(c.destination); return hp; }
  function squelch(c, when) { const n = Math.floor(c.sampleRate * .07), nb = c.createBuffer(1, n, c.sampleRate), d = nb.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * .25 * (1 - i / n); const s = c.createBufferSource(); s.buffer = nb; const g = c.createGain(); g.gain.value = .5; s.connect(g); g.connect(c.destination); s.start(when); }
  function toBuf(c, pcm, sr) { const b = c.createBuffer(1, pcm.length, sr), d = b.getChannelData(0); for (let i = 0; i < pcm.length; i++) d[i] = pcm[i] / 32768; return b; }
  function join(chunks) { let t = 0; chunks.forEach(x => t += x.length); const all = new Int16Array(t); let o = 0; chunks.forEach(x => { all.set(x, o); o += x.length; }); return all; }
  function remember(chunks, sr) { if (!chunks.length) return; lastVoice = { chunks, sr }; bRep.disabled = false; }
  function replay() {
    if (!lastVoice || !voiceOn) return; const c = ac(); if (!c) return;
    const buf = toBuf(c, join(lastVoice.chunks), lastVoice.sr), src = c.createBufferSource(); src.buffer = buf; src.connect(chain(c));
    const t = c.currentTime + .05; src.start(t); squelch(c, t + buf.duration);
  }
  // incoming stream from the controller (or another pilot on the frequency): chunks are played as they arrive
  function rx(j) {
    if (!j || !j.id || !voiceOn || (j.event || "").indexOf("replay") === 0) return;
    const c = ac(); if (!c) return; let r = rxs[j.id];
    if (j.event === "start") {
      rxs[j.id] = { chunks: [], sr: Number(j.meta && j.meta.sampleRate) || 16000, next: c.currentTime + .08, c, out: chain(c) };
      const who = (j.meta && j.meta.callsign) || ""; say("◀ " + who + (j.meta && j.meta.freq ? "  " + j.meta.freq : ""), 4000);
      if (!open) { open = true; autoExp = true; clearTimeout(collapseT); draw(); }
      return;
    }
    if (!r) return;
    if (j.event === "chunk" && j.data) {
      let pcm; try { pcm = AFVoice.b64ToPcm(j.data); } catch (e) { return; }
      if (!pcm.length) return; r.chunks.push(pcm);
      const src = c.createBufferSource(); src.buffer = toBuf(c, pcm, r.sr); src.connect(r.out);
      const when = Math.max(c.currentTime + .02, r.next); src.start(when); r.next = when + src.buffer.duration; return;
    }
    if (j.event === "end") { squelch(c, Math.max(c.currentTime, r.next)); remember(r.chunks, r.sr); delete rxs[j.id]; if (autoExp && !(S && S.pending)) { clearTimeout(collapseT); collapseT = setTimeout(() => { collapseT = null; if (autoExp) { open = false; autoExp = false; draw(); } }, 6000); } }
  }
  const MAX_CHUNKS = 330;   // about 26 s, under the server limit of one transmission
  async function pttStart() {
    if (ptt || !S) return;
    if (!S.freq) { say(T("Tune a frequency to talk", "Sintonize uma frequência para falar"), 3500); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say(T("No microphone available", "Microfone indisponível")); return; }
    const me = ptt = { id: "pc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), chunks: [], n: 0, ended: false, st: null, proc: null, src: null, enc: null };
    draw();
    let media; try { media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e) { if (ptt === me) ptt = null; say(T("Microphone blocked: allow it in Windows privacy settings", "Microfone bloqueado: permita nas configurações de privacidade do Windows"), 5000); return; }
    if (ptt !== me || me.ended) { media.getTracks().forEach(t => t.stop()); if (ptt === me) ptt = null; draw(); return; }
    me.st = media; const c = ac(); me.src = c.createMediaStreamSource(media); me.proc = c.createScriptProcessor(2048, 1, 1); me.enc = new AFVoice.PttEncoder(c.sampleRate);
    const ok = await window.ov.voice("start", { id: me.id, direction: "up", sampleRate: AFVoice.OUT_RATE });
    if (!ok) { cleanup(me); say(T("No live connection yet, try again", "Sem conexão ao vivo ainda, tente de novo"), 4000); return; }
    if (me.ended) { cleanup(me); window.ov.voice("end", { id: me.id }); return; }
    me.proc.onaudioprocess = e => { if (me.ended) return; for (const d of me.enc.push(new Float32Array(e.inputBuffer.getChannelData(0)))) sendChunk(me, d); if (me.n >= MAX_CHUNKS) pttEnd(); };
    me.src.connect(me.proc); me.proc.connect(c.destination); draw();
  }
  function sendChunk(me, d) { me.n++; me.chunks.push(AFVoice.b64ToPcm(d)); window.ov.voice("chunk", { id: me.id, data: d }); }
  function cleanup(me) { try { me.proc && me.proc.disconnect(); me.src && me.src.disconnect(); } catch (e) {} if (me.st) me.st.getTracks().forEach(t => t.stop()); if (ptt === me) ptt = null; draw(); }
  function pttEnd() {
    const me = ptt; if (!me || me.ended) return; me.ended = true;
    if (me.enc) { for (const d of me.enc.flush()) sendChunk(me, d); window.ov.voice("end", { id: me.id }); remember(me.chunks, AFVoice.OUT_RATE); }
    cleanup(me);
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
    const live = !!ptt && !!ptt.proc;
    bPtt.className = "ptt" + (live ? " live" : "") + (S.freq ? "" : " off");
    bPtt.textContent = live ? T("● LIVE · release to stop", "● AO VIVO · solte para parar") : (S.freq ? T("Hold to talk (PTT)", "Segure para falar (PTT)") : T("Tune a frequency to talk", "Sintonize para falar"));
    volB.textContent = voiceOn ? "🔊" : "🔇"; bRep.title = T("Replay last transmission", "Repetir última transmissão");
    fsec.textContent = "FREQ"; if (document.activeElement !== fIn) fIn.value = S.freq || "";
    fIn.placeholder = "ALL"; bAll.className = "fix" + (S.freq ? "" : " ok");
    quick.replaceChildren(...S.quick.map(q => h("button", { onclick: () => window.ov.freq("set", q.freq) }, q.pos + " " + q.freq)));
    const hn = hint.text && Date.now() < hint.until ? hint.text : ""; st.textContent = hn || S.status; st.className = "st" + (hn || S.status ? " f" : "");
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
  window.ov.onVoice(rx); window.ov.onState(onState); window.ov.ready();
})();
