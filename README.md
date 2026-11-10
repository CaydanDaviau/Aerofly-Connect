# Aerofly Connect

Free multiplayer and ATC for **Aerofly FS on Android**: install the app, fly, and see other pilots and controllers on a shared map. No account, no PC.

Built by Cayden with AI assistance ([Claude](https://claude.ai) by Anthropic). Not affiliated with IPACS (Aerofly FS) or the original Abflug app.

## Features

**Pilots (Android app)**
- Reads your flight from Aerofly and shares it with everyone, automatically (auto-generated key, no sign-up)
- Live map of all pilots and towers, with picture-in-picture while the sim is in front
- Floating ATC window over the sim: requests (taxi, takeoff, landing, mayday), Wilco / Unable, text chat and push-to-talk voice
- Automatic basic ATC when no human controller is online (clearances, runway sequencing, frequency handoffs), spoken with a radio voice
- Traffic advisories, hard-landing crash timeout, flight info (ETA, landing rate)
- English and Portuguese (BR)

**Controllers (app or any browser, `/atc` page)**
- Radar scope with flight strips, squawk assignment, messages, virtual towers, separation warnings
- Push-to-talk voice to pilots and replay of pilot clips

The Aerofly sim can run on the same phone or on another device on the same network or hotspot (Settings, "Sim on a different device").

## Download

Latest APK: <https://github.com/CaydanDaviau/Aerofly-Connect/releases/tag/android-latest> (file `AFConnect.apk`). It is not on Google Play, so Android asks you to allow installing from your browser or file manager. Play Protect may warn about a new unknown app; the APK is built from this repository by the public workflow in `.github/workflows/android.yml`, so you can check what it contains.

## Permissions and why

| Permission | Used for |
|---|---|
| Internet | Talk to the server, map tiles and airport data |
| Foreground service (data sync, microphone) + wake lock | Keep sharing your flight while the sim is in front |
| Notifications | Flight status and urgent ATC messages |
| Display over other apps | Floating ATC window (optional) |
| Microphone + modify audio settings | Push-to-talk voice (optional, only recorded while you hold the button) |

## Servers and data the app contacts

- The Aerofly Connect server (a Cloudflare Worker, source in `abflug-worker/`): positions, flight plans, messages, voice clips. Everything is held in memory and expires (clips 5 minutes, messages 30 minutes, positions 60 seconds).
- [OpenFreeMap](https://openfreemap.org) and OpenStreetMap data for the maps (© OpenStreetMap contributors).
- [OurAirports](https://ourairports.com/data/) data (runways, frequencies), downloaded once and cached on the phone.
- The map libraries are loaded from a public CDN (MapLibre GL JS).

Your callsign, aircraft, position and flight plan are visible to other users. The key stored on your phone identifies you to the server; keep it private.

## Repository layout

- `android-client/`: the Android app (Java, no AndroidX, minSdk 26)
- `abflug-worker/`: the server (Cloudflare Worker + Durable Object), the `/atc` radar page and the `/map` page. After editing `atc.html` or `map.html`, run `python3 build.py`; tests: `node test.mjs` and `node test-ws.mjs`
- `.github/workflows/android.yml`: builds and signs the APK

The server also accepts the original Abflug app (API reverse-engineered), but new features target Aerofly Connect only.

## Status

Hobby project, actively developed. Many features are young and only lightly field-tested; expect bugs. Issues and suggestions are welcome.

## License

MIT, see [LICENSE](LICENSE).
