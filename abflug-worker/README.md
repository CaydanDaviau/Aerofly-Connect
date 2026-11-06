# Abflug community server (Cloudflare Worker)
1. Upload these files to a new GitHub repo.
2. Cloudflare dashboard -> Workers & Pages -> Create -> Import a repository.
3. Copy the *.workers.dev URL into Abflug -> Settings -> Server URL. Any API key works.
Optional variables (Settings -> Variables): ABFLUG_KEYS="k1,k2" to restrict, DEBUG="1" to log requests.

## ATC radar and squawk assignment
- Open `https://<your-worker>/atc` in any browser, enter an API key. Dark radar scope + flight strips.
- Tap an aircraft (or its strip), then Assign / Auto / Clear a squawk. Codes are kept on the server for 12 h
  and the squawk the sim sends is ignored. Pilots are told the code by voice.
- Towers: a controller sets the in-app callsign to `TWR-<ICAO>` and parks at the airport (see Runways below).
- After editing `atc.html` run `python3 build.py` to regenerate `src/atc.js`.

## Runways
- The radar page loads OurAirports runway data in the browser (cached 30 days) and draws runways + identifiers.
  Type an airport code in the lat/lon box to jump to it.
- Controllers who need a tower icon in the Android app use a `TWR-<ICAO>` callsign (the app refuses `ATC_`);
  the Worker presents it as `ATC_<ICAO>` and fills model/livery so the app draws a tower.

## Virtual towers
- Radar page -> Towers box -> airport code (e.g. SBBR) -> Open tower. No sim or app needed. The tower is stored on the
  server for 24 h and listed to every player as `ATC_<code>` with model/livery set so the Android app draws a tower icon.
  The position comes from the runway data (unknown code = scope center). Close removes it. The page refreshes the
  towers it opened every 30 min while it is open.
- API: `PUT /api/atc/tower {name, latitude, longitude}`, `DELETE /api/atc/tower?name=`.
