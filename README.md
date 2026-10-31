# Job App Finder

Finds jobs near you by checking **local businesses' own websites**, not just job sites like Snagajob or LinkedIn. Many small businesses only post openings on their own "Careers" or "Join our team" page.

1. Pick a spot (type an address, use your location, or tap the map) and a radius.
2. The app pulls every business inside that circle from OpenStreetMap that lists a website.
3. It visits each website, finds the careers page, and reads the openings. It also reads the job boards small businesses often use (BambooHR, Greenhouse, Lever, Workable, Recruitee, Breezy, Ashby, SmartRecruiters). For boards it can't read (Workday, Paylocity, ADP, Indeed, etc.) it links you to them.
4. For each job it shows the **pay** and **hours** when listed. When they aren't listed, it shows an **estimate** (purple, marked `EST.`):
   - first from similar jobs it found nearby in the same search (median),
   - otherwise from built-in typical pay ranges by job type.
   Enter your local minimum wage to keep estimates from going below it.
5. **Leads** tab: businesses that have a careers page or a "Now hiring" notice but no openings the app could read. Worth a click or a visit.

You can save jobs (☆), filter, sort by pay, and download everything as a CSV.

## Run it

Needs Node.js 18 or newer.

```bash
npm install
npm start          # http://localhost:3000
```

### On BisectHosting

This needs a plan that can run **Node.js** (their Discord bot / Node.js hosting). A Minecraft or other game server plan won't run it.

1. In the BisectHosting panel, upload every file in this repo **except** `node_modules/`, or use the panel's Git option if it has one.
2. Set the startup / main file to `server.js`. Have the panel run `npm install`; most Node.js setups do this on start automatically.
3. Start the server. The app uses the port the panel assigns (`SERVER_PORT`) automatically.
4. Open `http://<your-server-ip>:<port>` on your phone.

Note: phones only allow **"Use my location"** on `https://` sites. Over plain `http://`, type an address or tap the map instead.

### Settings (optional environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `CONTACT_EMAIL` | — | Added to the map-data requests, as OpenStreetMap asks |
| `CONCURRENCY` | 8 | Websites checked at the same time |
| `MAX_BUSINESSES` | 400 | Upper limit per search |
| `MAX_FETCHES_PER_SITE` | 10 | Pages loaded per website |
| `OVERPASS_URL` | public servers | Map data server(s), comma separated |

## Good to know

- Only businesses that have a website listed in OpenStreetMap are checked. Turn on "Also list businesses with no website" to get those as call/visit leads.
- Big chains usually send you to a corporate careers site. Those show up as leads with a link.
- The crawler follows each site's `robots.txt` and loads at most 10 pages per site. Results are cached for 6 hours.
- Built-in pay ranges are rough U.S. figures. Edit `ROLES` in `src/estimate.js` to match your area.

## Tests

```bash
npm test
```
