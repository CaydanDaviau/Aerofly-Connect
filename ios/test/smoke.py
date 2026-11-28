# Headless smoke test of ios/www with the native plugin stubbed. Usage: python3 test/smoke.py
import subprocess, time, json, sys, os
from playwright.sync_api import sync_playwright
srv = subprocess.Popen(["python3", "-m", "http.server", "8765", "-d", "www"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
STUB = """
window.__calls=[];
window.AFSim={
 tcpRead:async(h,p,ms)=>{window.__calls.push(['tcp',h,p]);return '-15.871444|-47.980871|4543|279|299|217|232|1782';},
 tcpClose:async()=>{},keepAlive:async(on)=>{window.__calls.push(['keep',on]);},
 http:async(m,u,h,b)=>{window.__calls.push([m,u,b]);
  if(u.indexOf('/api/health')>0)return{status:200,body:JSON.stringify({pilots:3,latest_ios:'1.0.0'})};
  if(u.indexOf('/api/position')>0)return{status:200,body:JSON.stringify({messages:[{id:1,text:'Taxi to runway 11R, hold short',urgent:false}],traffic_alerts:[]})};
  return{status:200,body:'{}'};}
};"""
ok = True
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 800}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.route("**/cordova.js", lambda r: r.fulfill(content_type="text/javascript", body=STUB))
        pg.route("**/*workers.dev/**", lambda r: r.abort())
        pg.goto("http://localhost:8765/index.html"); pg.wait_for_timeout(800)
        def chk(n, c):
            global ok; print(("PASS " if c else "FAIL ") + n); ok = ok and c
        chk("start screen shows version + pilot count", "iOS" in pg.inner_text("#app") and "3" in pg.inner_text("#app"))
        pg.evaluate("window.afc.setFlight({callsign:'TST1',dep:'SBBR',arr:'SBGR'})")
        r = pg.evaluate("window.afc.start()"); pg.wait_for_timeout(4500)
        st = pg.evaluate("window.afc.state()")
        chk("flight started, no error", r == {} and st["running"])
        calls = pg.evaluate("window.__calls")
        pos = [c for c in calls if c[0] == "PUT" and "/api/position" in c[1]]
        chk("position uploaded with sim data", bool(pos) and "-15.871444" in pos[0][2])
        chk("flight plan sent", any("/api/flightplan" in str(c[1]) for c in calls if c[0] == "PUT"))
        chk("keep-alive on", ["keep", True] in calls)
        chk("tcp host 127.0.0.1:58585", ["tcp", "127.0.0.1", 58585] in calls)
        chk("ATC message ingested", any("Taxi" in m["text"] for m in st["messages"]))
        chk("FAB visible while flying", pg.is_visible("#atcFab"))
        pg.click("#atcFab"); pg.wait_for_timeout(800)
        fr = [f for f in pg.frames if "overlay.html" in f.url][0]
        chk("overlay panel in ATC sheet", fr.query_selector(".panel") is not None)
        pg.evaluate("window.afc.stop()"); pg.wait_for_timeout(500)
        chk("keep-alive off after stop", ["keep", False] in pg.evaluate("window.__calls"))
        chk("no page errors", not errs)
        if errs: print(errs[:3])
        b.close()
finally:
    srv.kill()
sys.exit(0 if ok else 1)
