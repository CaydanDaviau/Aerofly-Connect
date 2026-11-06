# Abflug community server (Cloudflare Worker)
1. Upload these files to a new GitHub repo.
2. Cloudflare dashboard -> Workers & Pages -> Create -> Import a repository.
3. Copy the *.workers.dev URL into Abflug -> Settings -> Server URL. Any API key works.
Optional variables (Settings -> Variables): ABFLUG_KEYS="k1,k2" to restrict, DEBUG="1" to log requests.

## ATC radar and squawk assignment
- Open `https://<your-worker>/atc` in any browser, enter an API key. Dark radar scope + flight strips.
- Tap an aircraft (or its strip), then Assign / Auto / Clear a squawk. Codes are kept on the server for 12 h
  and the squawk the sim sends is ignored. Pilots are told the code by voice.
- Towers: set the in-app callsign to `ATC_<ICAO>` and park at the airport; shown as a tower on every map.
- After editing `atc.html` run `python3 build.py` to regenerate `src/atc.js`.
