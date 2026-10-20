# Charter Desk VA

A standalone virtual airline where every pilot runs their own charter company. Pilots quote on a shared request board, take private phone bookings, fly the trips in their sim with the Charter Desk Tracker, and get paid from the real flight data.

```
web/         The website pilots use (hosted free on GitHub Pages)
supabase/    Database, sign-in and every game rule (hosted free on Supabase)
tracker/     Windows flight tracker for MSFS (FSUIPC7), P3D (FSUIPC6) and X-Plane (XPUIPC)
.github/     Builds the tracker and publishes the website automatically
```

## Set it up (about 30 minutes)

### 1. Create the database

1. Create a free project at [supabase.com](https://supabase.com). Pick the region closest to most of your pilots.
2. Open **SQL Editor**, paste in the whole of `supabase/schema.sql` and run it.
3. Do the same with `supabase/seed.sql`. This adds the ten aircraft types, client types and 48 starter airports.
4. Go to **Project Settings → API** and note:
   - the **Project URL**
   - the **anon public** key. If you see the newer *publishable* keys, open the **Legacy API keys** tab and use the anon key from there.

The anon key is meant to be public. Pilots can only read data through the database's row security, and every change to money, fleet or reputation goes through functions that enforce the rules.

### 2. Put the code on GitHub

1. Create a new GitHub repository (for example `charter-va`) and push this folder to it.
2. Edit `web/config.js` with your Project URL and anon key. Set `trackerDownloadUrl` to `https://github.com/<you>/charter-va/releases/tag/tracker-latest`.
3. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Push to `main`. Two workflows run:
   - **Publish website** puts the site at `https://<you>.github.io/charter-va/`.
   - **Build tracker** compiles `CharterDeskTracker.exe` and attaches it to the `tracker-latest` release.

### 3. Connect sign-in to your site

In Supabase, open **Authentication → URL Configuration**:
- **Site URL:** your GitHub Pages address.
- **Redirect URLs:** add the same address.

By default Supabase emails new pilots a confirmation link. You can turn that off under **Authentication → Sign In / Providers → Email** if you'd rather approve people another way.

### 4. Become the owner

Open your site and create the first account. **The first pilot to set up a company becomes staff automatically.** You'll see a **Staff** tab where you can:
- review flight reports that failed an automatic check,
- import more airports,
- change the VA name, market time zone, starting cash and board size,
- give other pilots staff access or adjust balances.

### 5. Add airports

The board only offers routes between airports in the database. In **Staff → Airports**, paste CSV rows:

```
ICAO,Name,City,Country,Latitude,Longitude,Tags
LFKC,Calvi Sainte-Catherine,Calvi,FR,42.5308,8.7933,leisure
```

Tags shape demand by time of day and season: `biz` (busy in the morning), `leisure` (busy in the evening), `ski` (busy December to March), `long` (less frequent long-haul). The free [OurAirports](https://ourairports.com/data/) list is a good source of coordinates.

## How pilots fly

1. Install FSUIPC for their sim: FSUIPC7 for MSFS 2020/2024, FSUIPC6 for P3D, XPUIPC for X-Plane. The free versions are enough.
2. Download the tracker from the Profile page and paste in their personal setup code.
3. Win a job on the board or accept a phone call. If the aircraft is somewhere else, a positioning leg is added first. They can fly it or pay a contract crew.
4. Load the aircraft at the departure gate, select the booking in the tracker, press **Start flight** and fly.
5. When they park with the brake set or engines off, the tracker files the report. Clean reports are paid instantly; anything that fails a check waits for staff.

### What the tracker checks

| Check | Passes when |
|---|---|
| Departure and arrival | Block off and block on within 3 nm of the booked airports |
| Aircraft | The sim aircraft title contains one of the type's match words (editable in `aircraft_types.sim_match`) |
| Speed | Average airborne speed under 1.35× the type's cruise speed, which catches sim-rate acceleration |
| Sim rate, slew, crash | Never above 1×, never slewed, no crash |
| Overspeed | Under 60 seconds above 250 kt below 10,000 ft |

Payout is the price minus operating cost for the actual block time. Reputation and tips come from the landing rate (150 fpm or softer earns a 5% tip), bounces, leaving within 30 minutes of the booked time, and not overrunning the quoted time.

## Game rules in brief

- **Shared board.** Every pilot sees the same requests. The first quote starts the broker's timer; anyone can join before it runs out. The cheapest quote relative to each aircraft's market rate wins, adjusted for reputation and the Broker relations upgrade, as long as it beats the outside operators and fits the client's hidden budget.
- **Phone calls.** Each pilot gets private offers 15–45% above market, with 90 seconds to answer.
- **Lapsed bookings.** A charter not flown within 48 hours of its departure time is cancelled with a reputation penalty.
- **Shop.** Aircraft lease deposits, fleet slots and six company upgrades, all paid with in-game money.

## Notes and limits

- The tracker reads standard FSUIPC offsets. XPUIPC doesn't fill every offset the same way; if X-Plane reports show zero fuel used or odd landing rates, send me a report and I'll adjust it.
- The tracker hasn't flown a real sim session yet. Do a short test hop in each sim you support before opening the VA.
- Supabase's free tier pauses a project after a week with no activity. Any visit wakes it, and an active VA won't hit this.
