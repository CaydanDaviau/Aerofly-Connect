(async function () {
  const root = document.getElementById("app");
  let cfg = await window.afc.cfg();
  let lang = cfg.lang || (/^pt/i.test(cfg.locale || navigator.language) ? "pt" : "en");
  const t = (en, pt) => (lang === "pt" ? pt : en);
  let st = (await window.afc.state()) || { running: false };
  let screen = "start", tick = null, healthT = null, statusEls = null;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") e.className = attrs[k]; else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  }
  const card = (title, ...kids) => h("div", { class: "card" }, title ? h("h2", {}, title) : null, ...kids);
  const mmss = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function clear() { clearInterval(tick); clearInterval(healthT); statusEls = null; root.replaceChildren(); }
  function go(s) { screen = s; render(); }
  function bg() { document.body.dataset.screen = screen; }

  // ---------- Start ----------
  function startScreen() {
    const count = h("div", { class: "count" }, "● …");
    const banner = h("div", { class: "banner", style: "display:none" });
    const updBar = h("div", { class: "banner", style: "display:none;cursor:pointer;background:#FFC107;color:#000", onclick: () => window.afc.open("update") });
    const newer = (a, b) => { const x = String(a).split("."), y = String(b).split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = parseInt(x[i]) || 0, q = parseInt(y[i]) || 0; if (p !== q) return p > q; } return false; };
    const upd = async () => {
      const n = await window.afc.health();
      count.textContent = n == null ? "" : "● " + n + t(n === 1 ? " pilot flying" : " pilots flying", n === 1 ? " piloto voando" : " pilotos voando");
      const lv = await window.afc.latest();
      if (lv && newer(lv, cfg.version)) { updBar.style.display = ""; updBar.textContent = t("Update available: v" + lv + " (click to download)", "Atualização disponível: v" + lv + " (clique para baixar)"); } else updBar.style.display = "none";
      const left = (cfg.crashUntil || 0) - Date.now();
      banner.style.display = left > 0 ? "" : "none";
      if (left > 0) banner.textContent = t("Crash timeout - you can fly again in ", "Castigo por queda - você pode voar de novo em ") + mmss(left);
    };
    upd(); healthT = setInterval(upd, 15000); tick = setInterval(() => { const left = (cfg.crashUntil || 0) - Date.now(); banner.style.display = left > 0 ? "" : "none"; if (left > 0) banner.textContent = t("Crash timeout - you can fly again in ", "Castigo por queda - você pode voar de novo em ") + mmss(left); }, 1000);
    root.append(
      h("img", { class: "logo", src: "../assets/logo.png" }), h("h1", {}, "Aerofly Connect"),
      h("div", { class: "ver" }, "v" + cfg.version + " PC"), count, updBar, banner,
      h("div", { class: "card click", onclick: () => go("pilot") }, h("h2", {}, "Pilot"), h("p", {}, t("Share your flight with other pilots and ATC", "Compartilhe seu voo com outros pilotos e o ATC"))),
      h("div", { class: "card click", onclick: () => window.afc.open("atc") }, h("h2", {}, t("Controller", "Controlador")), h("p", {}, t("See the radar and message pilots (opens in your browser)", "Veja o radar e envie mensagens aos pilotos (abre no navegador)"))),
      h("button", { class: "wide", onclick: () => go("profile") }, t("Profile", "Perfil")),
      h("button", { class: "wide", onclick: () => go("settings") }, t("Settings", "Configurações")),
    );
  }

  // ---------- Profile ----------
  function profileScreen() {
    const hm = s => { const m = Math.floor((s || 0) / 60); return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min"; };
    const nick = h("input", { maxlength: "20", autocomplete: "off", spellcheck: "false" });
    const fl = h("div", { class: "big" }, "--"), fc = h("div", { class: "big" }, "--"), at = h("div", { class: "big" }, "--");
    const msg = h("div", { class: "note" });
    window.afc.profile().then(p => {
      if (screen !== "profile") return;
      if (!p || p.error) { msg.textContent = t("No connection", "Sem conexão"); return; }
      nick.value = p.nick || ""; fl.textContent = hm(p.flight_s); fc.textContent = String(p.flights || 0); at.textContent = hm(p.atc_s);
    });
    const save = h("button", { class: "wide primary", onclick: async () => {
      const p = await window.afc.profile(nick.value.trim());
      msg.textContent = !p || p.error ? (p && p.error !== "net" ? p.error : t("No connection", "Sem conexão")) : t("Saved", "Salvo");
    } }, t("Save nickname", "Salvar apelido"));
    root.append(
      h("button", { class: "back", onclick: () => go("start") }, "← " + t("Back", "Voltar")),
      h("h1", {}, t("Profile", "Perfil")),
      card(t("Pilot / controller", "Piloto / controlador"), h("label", {}, t("Nickname", "Apelido")), nick,
        h("label", {}, t("Flight time (in the air)", "Tempo de voo (no ar)")), fl,
        h("label", {}, t("Flights completed", "Voos concluídos")), fc,
        h("label", {}, t("ATC time (holding a division)", "Tempo de ATC (com uma divisão)")), at),
      save, msg,
    );
  }

  // ---------- Pilot ----------
  const FIELDS = [["callsign", "Callsign", "Indicativo"], ["dep", "Departure (ICAO)", "Partida (ICAO)"], ["arr", "Arrival (ICAO)", "Chegada (ICAO)"],
    ["deprwy", "Dep runway", "Pista de partida"], ["arrrwy", "Arr runway", "Pista de chegada"], ["model", "Aircraft model", "Modelo da aeronave"],
    ["livery", "Registration (e.g. N899SB)", "Matrícula (ex. PR-ABC)"], ["cruise", "Cruise altitude", "Altitude de cruzeiro"], ["route", "Route", "Rota"]];

  function pilotScreen() {
    const f = cfg.flight, inputs = {};
    const locked = () => st.running;
    const fld = (k, en, pt) => { const i = h("input", { value: f[k] || "", autocomplete: "off", spellcheck: "false", oninput: () => { f[k] = i.value; window.afc.setFlight({ [k]: i.value }); } }); inputs[k] = i; return [h("label", {}, t(en, pt)), i]; };
    const sbMsg = h("div", { class: "note" });
    const sbBtn = h("button", { class: "wide", onclick: async () => {
      if (!cfg.simbrief) { sbMsg.textContent = t("Enter your SimBrief username or ID in Settings first.", "Digite seu usuário ou ID do SimBrief em Configurações primeiro."); return; }
      sbMsg.textContent = "…"; const p = await window.afc.simbrief(cfg.simbrief);
      if (p.error) { sbMsg.textContent = { net: t("No connection to SimBrief.", "Sem conexão com o SimBrief."), user: t("SimBrief user not found.", "Usuário do SimBrief não encontrado."), noplan: t("No flight plan found.", "Nenhum plano de voo encontrado."), bad: t("Unreadable answer.", "Resposta ilegível.") }[p.error]; return; }
      const set = { callsign: p.callsign, dep: p.dep, arr: p.arr, deprwy: p.depRwy, arrrwy: p.arrRwy, model: p.model, livery: p.reg || undefined, cruise: p.cruise, route: p.route };
      for (const k in set) { if (set[k]) { f[k] = set[k]; inputs[k].value = set[k]; } }
      window.afc.setFlight(f); cfg.sbRoute = { dep: p.dep }; sbMsg.textContent = t("Imported ", "Importado ") + p.dep + " → " + p.arr + " (" + p.points.length + " " + t("waypoints", "pontos") + ")";
    } }, t("Import from SimBrief", "Importar do SimBrief"));
    const go_ = h("button", { class: "primary wide" });
    go_.addEventListener("click", async () => {
      if (st.running) { await window.afc.stop(); return; }
      const r = await window.afc.start();
      if (r && r.error) {
        const left = r.left ? mmss(r.left) : "";
        sbMsg.textContent = { crash: t("Crash timeout: wait ", "Castigo por queda: aguarde ") + left, noip: t("Enter the sim device IP in Settings.", "Digite o IP do dispositivo do simulador em Configurações."), mobile: t("That is a mobile-data address. Use the Wi-Fi IP of the device running Aerofly.", "Esse é um endereço de dados móveis. Use o IP Wi-Fi do dispositivo com o Aerofly."), invalid: t("The sim IP is not valid.", "O IP do simulador não é válido.") }[r.error] || r.error;
      }
    });
    const rows = {};
    const kv = (k, en, pt) => { const v = h("span", {}, "-"); rows[k] = v; return h("div", { class: "kv" }, h("span", {}, t(en, pt)), v); };
    const msgs = h("div", {});
    statusEls = { go_, inputs, rows, msgs, sbBtn, locked };
    root.append(
      h("button", { class: "back", onclick: () => go("start") }, "← " + t("Back", "Voltar")),
      card(t("Flight", "Voo"), FIELDS.flatMap(x => fld(...x)), sbBtn, sbMsg),
      go_,
      h("div", { style: "height:12px" }),
      card(t("Status", "Status"), kv("run", "State", "Estado"), kv("sim", "Sim link", "Link do sim"), kv("srv", "Server", "Servidor"), kv("up", "Uploads", "Envios"), kv("ph", "Phase", "Fase"), kv("eta", "ETA", "ETA"), kv("fpm", "Landing rate", "Razão de pouso"), kv("key", "Key", "Chave"), kv("raw", "Last sim data", "Último dado do sim")),
      card(t("ATC messages", "Mensagens do ATC"), msgs),
      h("button", { class: "wide", onclick: () => window.afc.open("map") }, t("Open map", "Abrir mapa")),
    );
    rows.key.textContent = cfg.key;
    paint();
  }

  function paint() {
    if (!statusEls) return;
    const { go_, inputs, rows, msgs, sbBtn } = statusEls;
    go_.textContent = st.running ? t("Stop", "Parar") : t("Start", "Iniciar");
    go_.className = "wide " + (st.running ? "danger" : "primary");
    for (const k in inputs) inputs[k].disabled = !!st.running;
    sbBtn.disabled = !!st.running;
    rows.run.textContent = st.running ? t("FLYING", "VOANDO") : t("STOPPED", "PARADO");
    rows.run.className = st.running ? "good" : "dim";
    rows.sim.textContent = st.sim || "-"; rows.srv.textContent = st.server || "-";
    rows.up.textContent = (st.uploads || 0) + (st.failed ? " (" + st.failed + " " + t("failed", "falhas") + ")" : "");
    const PN = { ground: t("On the ground", "No solo"), runway: t("On the runway", "Na pista"), air: t("Airborne", "Voando") };
    rows.ph.textContent = st.running && st.phase ? PN[st.phase] + ((st.offers || []).length ? " · " + st.offers.join(", ") : "") : "-";
    rows.eta.textContent = st.running && st.eta >= 0 ? (st.eta >= 60 ? Math.floor(st.eta / 60) + "h" + String(st.eta % 60).padStart(2, "0") : st.eta + " min") : "-";
    rows.fpm.textContent = st.landFpm != null ? st.landFpm + " ft/min" : "-";
    rows.raw.textContent = st.raw ? String(st.raw).slice(0, 90) : "-";
    msgs.replaceChildren(...((st.messages || []).length ? st.messages.map(m => h("div", { class: "msg" + (m.urgent ? " urgent" : "") }, m.text)) : [h("div", { class: "dim small" }, t("No messages yet.", "Nenhuma mensagem ainda."))]));
    if (st.crash) { cfg.crashUntil = st.crash.until; }
  }

  // ---------- Settings ----------
  function settingsScreen() {
    const seg = (cur, opts, on) => h("div", { class: "seg" }, opts.map(([v, label]) => { const b = h("button", { class: v === cur ? "on" : "", onclick: () => on(v) }, label); return b; }));
    const ip = h("input", { value: cfg.simIp || "", placeholder: "192.168.1.20", autocomplete: "off", spellcheck: "false", oninput: () => { cfg.simIp = ip.value.trim(); window.afc.set({ simIp: cfg.simIp }); } });
    const ipBox = h("div", { style: cfg.simSource === "tcp" ? "" : "display:none" }, h("label", {}, t("IP of the device running Aerofly", "IP do dispositivo com o Aerofly")), ip,
      h("div", { class: "note" }, t("Phone, iPhone or iPad running Aerofly FS on the same Wi-Fi (not a mobile-data 192.0.0.x address). Port 58585.", "Celular, iPhone ou iPad com o Aerofly FS no mesmo Wi-Fi (não um endereço de dados móveis 192.0.0.x). Porta 58585.")));
    const simNote = h("div", { class: "note" }, cfg.simSource === "udp" ? t("In Aerofly on this PC set the address to 127.0.0.1, port 49002.", "No Aerofly deste PC use o endereço 127.0.0.1, porta 49002.") : "");
    const grp = h("input", { value: cfg.group || "", placeholder: t("Network code (from Discord)", "Código da rede (do Discord)"), autocomplete: "off", spellcheck: "false", oninput: () => { cfg.group = grp.value.trim(); window.afc.set({ group: cfg.group }); } });
    const sb = h("input", { value: cfg.simbrief || "", placeholder: t("Username or ID", "Usuário ou ID"), autocomplete: "off", spellcheck: "false", oninput: () => { cfg.simbrief = sb.value.trim(); window.afc.set({ simbrief: cfg.simbrief }); } });
    const aErr = { bad_name: t("Name: 3-20 letters, digits, . _ -", "Nome: 3-20 letras, números, . _ -"), bad_password: t("Password: 6-100 characters", "Senha: 6-100 caracteres"), name_taken: t("Name already taken", "Nome já em uso"), bad_login: t("Wrong name or password", "Nome ou senha incorretos"), too_many_attempts: t("Too many attempts, wait 10 min", "Muitas tentativas, espere 10 min"), flight: t("Stop the flight first", "Pare o voo primeiro"), net: t("No connection", "Sem conexão") };
    const aMsg = h("div", { class: "note" });
    let acct;
    if (cfg.token) {
      acct = card(t("Account", "Conta"), h("div", {}, t("Signed in as ", "Conectado como ") + (cfg.acctName || "")),
        h("button", { class: "wide", onclick: async () => { await window.afc.account("logout"); cfg.token = ""; cfg.acctName = ""; render(); } }, t("Sign out", "Sair")));
    } else {
      const an = h("input", { placeholder: t("Name", "Nome"), autocomplete: "off", spellcheck: "false" });
      const ap = h("input", { type: "password", placeholder: t("Password", "Senha"), autocomplete: "off" });
      const go2 = op => async () => {
        const r = await window.afc.account(op, an.value.trim(), ap.value);
        if (r.error) { aMsg.textContent = aErr[r.error] || r.error; return; }
        cfg.token = "x"; cfg.acctName = r.name; render();
      };
      acct = card(t("Account", "Conta"), an, ap, h("button", { class: "wide", onclick: go2("login") }, t("Log in", "Entrar")), h("button", { class: "wide", onclick: go2("register") }, t("Create account", "Criar conta")), aMsg,
        h("div", { class: "note" }, t("Optional. Your flight time and flights follow the account on any device.", "Opcional. Seu tempo de voo e voos acompanham a conta em qualquer dispositivo.")));
    }
    root.append(
      h("button", { class: "back", onclick: () => go("start") }, "← " + t("Back", "Voltar")),
      acct,
      card(t("Sim link", "Link do simulador"),
        seg(cfg.simSource, [["udp", t("Aerofly on this PC", "Aerofly neste PC")], ["tcp", t("Aerofly on another device", "Aerofly em outro dispositivo")]], v => { cfg.simSource = v; window.afc.set({ simSource: v }); render(); }),
        simNote, ipBox),
      card("Aerofly Connect ATC Network", grp, h("div", { class: "note" }, t("Posted in the Discord server. Members only see each other. Leave empty for the public section.", "Publicado no servidor do Discord. Membros só veem uns aos outros. Deixe vazio para a seção pública."))),
      card(t("Language", "Idioma"), seg(lang, [["en", "English"], ["pt", "Português (BR)"]], v => { lang = v; cfg.lang = v; window.afc.set({ lang: v }); render(); })),
      card(t("ATC overlay", "Overlay do ATC"), h("div", { class: "sw" }, h("span", {}, t("Show the ATC window over the sim while flying", "Mostrar a janela do ATC sobre o simulador durante o voo")), h("input", { type: "checkbox", checked: cfg.overlay !== false, onchange: e => { cfg.overlay = e.target.checked; window.afc.set({ overlay: cfg.overlay }); } })), h("div", { class: "note" }, t("Takes effect at the next Start. Works over windowed or borderless sims.", "Vale a partir do próximo Início. Funciona sobre simuladores em janela ou sem borda."))),
      card(t("Map and radar", "Mapa e radar"), h("div", { class: "sw" }, h("span", {}, t("Open them in the browser instead of an app window", "Abrir no navegador em vez de uma janela do app")), h("input", { type: "checkbox", checked: !!cfg.browser, onchange: e => { cfg.browser = e.target.checked; window.afc.set({ browser: cfg.browser }); } })), h("div", { class: "note" }, t("Use this if the map window stays blank on your system.", "Use se a janela do mapa ficar em branco no seu sistema."))),
      card("SimBrief", sb, h("div", { class: "note" }, t("Used by the Import button on the Pilot screen.", "Usado pelo botão Importar na tela Piloto."))),
    );
  }

  function render() { clear(); bg(); if (screen === "pilot") pilotScreen(); else if (screen === "settings") settingsScreen(); else if (screen === "profile") profileScreen(); else startScreen(); }
  window.afc.onState(s => { st = s; if (s.crash) cfg.crashUntil = s.crash.until; paint(); });
  render();
})();
