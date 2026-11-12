"""Aerofly Connect for PC (stage 1): Aerofly FS on PC -> UDP 49002 -> server. Python stdlib only."""
import json, os, secrets, socket, sys, threading, time, urllib.request, urllib.error, webbrowser

SERVER = "https://aeroflytest.caydanphoenix14.workers.dev"
PORT = 49002
VERSION = "0.1.0"
M_TO_FT, MS_TO_KT = 3.28084, 1.943844
FIELDS = [("callsign", "Callsign"), ("dep", "Departure (ICAO)"), ("arr", "Arrival (ICAO)"),
          ("deprwy", "Dep runway"), ("arrrwy", "Arr runway"), ("model", "Aircraft model"),
          ("livery", "Livery"), ("cruise", "Cruise altitude"), ("route", "Route")]


def cfg_path():
    d = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "AeroflyConnect")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "config.json")


def load_cfg():
    try:
        with open(cfg_path(), encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        c = {}
    if not c.get("key"):
        c["key"] = "rv" + secrets.token_hex(8)
    return c


def save_cfg(c):
    try:
        with open(cfg_path(), "w", encoding="utf-8") as f:
            json.dump(c, f)
    except Exception:
        pass


class UdpLink:
    """ForeFlight format: XGPS<name>,lon,lat,alt_m,track,gs_ms  /  XATT<name>,true_hdg,pitch,roll."""
    def __init__(self):
        self.lat = self.lon = self.alt = self.track = self.gs = 0.0
        self.hdg = None; self.vs = 0.0; self.gps_at = 0.0
        self._last_alt = None; self._last_at = 0.0
        self.error = ""; self.run = False; self.sock = None

    def handle(self, t, now=None):
        now = time.time() if now is None else now
        try:
            f = t.strip().split(",")
            if t.startswith("XGPS") and len(f) >= 6:
                lo, la, alt = float(f[1]), float(f[2]), float(f[3]) * M_TO_FT
                if self._last_alt is None:
                    self._last_alt, self._last_at = alt, now
                elif now - self._last_at >= 0.8:
                    v = (alt - self._last_alt) * 60.0 / (now - self._last_at)
                    self.vs = self.vs * 0.6 + v * 0.4
                    self._last_alt, self._last_at = alt, now
                self.lon, self.lat, self.alt = lo, la, alt
                self.track, self.gs, self.gps_at = float(f[4]), float(f[5]) * MS_TO_KT, now
            elif t.startswith("XATT") and len(f) >= 2:
                self.hdg = float(f[1])
        except ValueError:
            pass

    def position(self, now=None):
        now = time.time() if now is None else now
        if now - self.gps_at > 3 or abs(self.lat) > 90 or abs(self.lon) > 180 or (self.lat == 0 and self.lon == 0):
            return None
        return {"latitude": self.lat, "longitude": self.lon, "altitude_ft": round(self.alt),
                "heading_true": round(self.track if self.hdg is None else self.hdg),
                "ground_speed": round(self.gs), "vertical_speed_ft_min": round(self.vs)}

    def start(self):
        self.run = True
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self.run = False
        try:
            self.sock.close()
        except Exception:
            pass

    def _loop(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("", PORT)); s.settimeout(1.0); self.sock = s
            while self.run:
                try:
                    data, _ = s.recvfrom(1024)
                except socket.timeout:
                    continue
                self.handle(data.decode("ascii", "ignore"))
        except Exception as e:
            if self.run:
                self.error = type(e).__name__ + ": " + str(e)


def api(method, path, body, key, timeout=6):
    req = urllib.request.Request(SERVER + path, method=method, headers={"X-API-Key": key, "Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception:
        return 0, {}


class Flight(threading.Thread):
    def __init__(self, link, form, key, on_status):
        super().__init__(daemon=True)
        self.link, self.form, self.key, self.on_status = link, form, key, on_status
        self.run_flag = True; self.uploads = 0; self.msg = ""

    def stop(self):
        self.run_flag = False

    def run(self):
        f = self.form; plan_sent = False
        while self.run_flag:
            p = self.link.position()
            if p is None:
                self.on_status("Waiting for Aerofly data on UDP %d..." % PORT, self.msg)
            else:
                for k, name in (("model", "airplane_model"), ("livery", "airplane_livery")):
                    if f.get(k): p[name] = f[k]
                p["voice"] = False
                if not plan_sent:
                    plan = {n: (f[k].upper() if k in ("dep", "arr", "deprwy", "arrrwy") else f[k])
                            for k, n in (("callsign", "callsign"), ("dep", "departure_airport"), ("arr", "arrival_airport"),
                                         ("deprwy", "departure_runway"), ("arrrwy", "arrival_runway"),
                                         ("cruise", "cruise_altitude"), ("route", "flightplan_route")) if f.get(k)}
                    c, _ = api("PUT", "/api/flightplan", plan, self.key)
                    plan_sent = 0 < c < 400
                c, r = api("PUT", "/api/position", p, self.key)
                if c == 423:
                    self.on_status("CRASHED: hard landing. You can fly again in %d s." % r.get("remaining_s", 300), "")
                    self.run_flag = False; break
                if 0 < c < 400:
                    self.uploads += 1
                    for m in r.get("messages", []):
                        self.msg = "ATC: " + str(m.get("text", ""))
                    self.on_status("FLYING  ALT %d ft  GS %d kt  uploads %d" % (p["altitude_ft"], p["ground_speed"], self.uploads), self.msg)
                else:
                    self.on_status("Server error (%s), retrying..." % c, self.msg)
            time.sleep(3)
        api("DELETE", "/api/position", None, self.key)


def main():
    import tkinter as tk
    cfg = load_cfg()
    root = tk.Tk(); root.title("Aerofly Connect for PC v" + VERSION)
    bg, fg, acc = "#00414B", "#E8F6F5", "#4FE3D0"
    root.configure(bg=bg, padx=14, pady=12)
    tk.Label(root, text="Aerofly Connect  PC", bg=bg, fg=acc, font=("Segoe UI", 16, "bold")).grid(row=0, column=0, columnspan=2, sticky="w")
    tk.Label(root, text="In Aerofly FS: flight data output to this PC (127.0.0.1), port %d" % PORT, bg=bg, fg="#8FBCC0").grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 8))
    ents = {}
    for i, (k, label) in enumerate(FIELDS):
        tk.Label(root, text=label, bg=bg, fg=fg).grid(row=i + 2, column=0, sticky="w", pady=2)
        e = tk.Entry(root, width=34, bg="#01242A", fg=fg, insertbackground=fg, relief="flat")
        e.insert(0, cfg.get("f_" + k, "")); e.grid(row=i + 2, column=1, pady=2, padx=(8, 0)); ents[k] = e
    link = UdpLink(); link.start()
    st = tk.StringVar(value="STOPPED"); ms = tk.StringVar()
    state = {"fl": None}
    r = len(FIELDS) + 2
    btn = tk.Button(root, text="Start", bg=acc, fg="#00262C", relief="flat", width=14)
    btn.grid(row=r, column=0, pady=10, sticky="w")

    def status(a, b):
        root.after(0, lambda: (st.set(a + ("  [UDP: " + link.error + "]" if link.error else "")), ms.set(b)))

    def toggle():
        fl = state["fl"]
        if fl and fl.is_alive():
            fl.stop(); btn.config(text="Start", bg=acc); st.set("STOPPED"); return
        form = {k: e.get().strip() for k, e in ents.items()}
        cfg.update({"f_" + k: v for k, v in form.items()}); save_cfg(cfg)
        state["fl"] = Flight(link, form, cfg["key"], status); state["fl"].start()
        btn.config(text="Stop", bg="#E5584D")
    btn.config(command=toggle)
    tk.Button(root, text="Open map", relief="flat", command=lambda: webbrowser.open(SERVER + "/map?key=" + cfg["key"])).grid(row=r, column=1, sticky="w", padx=(8, 0))
    tk.Button(root, text="Open radar (ATC)", relief="flat", command=lambda: webbrowser.open(SERVER + "/atc?key=" + cfg["key"])).grid(row=r, column=1, sticky="e")
    tk.Label(root, textvariable=st, bg=bg, fg=acc, wraplength=420, justify="left").grid(row=r + 1, column=0, columnspan=2, sticky="w")
    tk.Label(root, textvariable=ms, bg=bg, fg="#5CE0A0", wraplength=420, justify="left").grid(row=r + 2, column=0, columnspan=2, sticky="w")

    def close():
        if state["fl"]: state["fl"].stop()
        link.stop(); time.sleep(0.4); root.destroy()
    root.protocol("WM_DELETE_WINDOW", close)
    root.mainloop()


if __name__ == "__main__":
    main()
