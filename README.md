# School Booking — multi-yard

One deploy, many yards. This replaces the single-yard app — treat it as a
new Railway service, not an upgrade-in-place of the old one (though it can
absorb the old database automatically — see "Migrating your existing yard"
below).

## How it's structured

- **Public board**: `/y/:slug` — e.g. `/y/joda-farm`. This is what you give
  each yard to bookmark / add to their home screen.
- **Yard admin**: `/y/:slug/admin` — password-gated settings for that one
  yard (display name, arena name, booking hours, its own admin password).
- **Superadmin**: `/superadmin` — this is yours. Create yards, view booking
  counts, deactivate a yard, reset a yard's admin password if they lose it.

Every yard is a row in a `yards` table. Bookings, share requests, and push
subscriptions are all scoped by `yard_id`, so two yards can book the same
date/slot combination independently and nobody sees another yard's board.

## If the deploy crash-loops with "Segmentation fault"

This means the `better-sqlite3` native binary that got installed doesn't
match the container it's running in — it's an environment problem, not an
app bug, and it fails silently (no real error, just a segfault before any
of the app's own log lines print). Two things in this repo guard against
it:

- `package.json` pins `better-sqlite3` to `9.4.3` (the version your other
  Control apps already run successfully) and pins Node to `20.x`, so build
  and runtime can't drift apart.
- `.npmrc` forces it to compile from source on install rather than trust a
  downloaded prebuilt binary, so it's always built for the exact container
  it'll run in.

If you ever see this again after changing Node versions or dependency
versions, that's almost certainly the cause — check those two files first.

## Setting up on Railway

1. **New service**, deploy from this repo (GitHub auto-deploy, same as your
   other apps).
2. **Attach a volume** mounted at `/data` (same pattern as your other Control
   apps) — this is where the SQLite file lives.
3. **Environment variables**:
   | Variable | What it's for | Required? |
   |---|---|---|
   | `DB_PATH` | Path to the SQLite file, e.g. `/data/yardbook.db` | Yes — without it, data won't survive a redeploy |
   | `SUPERADMIN_PASSWORD` | Your login at `/superadmin` | Yes — defaults to `changeme`, don't leave it |
   | `ADMIN_JWT_SECRET` | Signs admin session cookies | Yes — defaults to a dev value, set a long random string |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Push notifications | Optional — a working pair is baked in, but generate your own with `npx web-push generate-vapid-keys` if you want to rotate them |
   | `NODE_ENV` | Set to `production` | Recommended — makes cookies `secure` (HTTPS-only) |
   | `SUPPORT_CONTACT` | Shown to visitors on an expired board, e.g. `andy@hqcontrol.co.uk` | Optional — falls back to generic "contact your provider" wording if unset |

4. **First login**: go to `/superadmin`, log in with `SUPERADMIN_PASSWORD`,
   and create your first yard. You'll get its board URL and admin URL back —
   give the admin URL + password to whoever runs that yard.

## QR codes

Every yard gets a QR code for free, pointing straight at its board — no
extra service, generated on the fly by the app itself:

- **From the yard's own admin page** (`/y/:slug/admin`): a preview, an
  "Open printable page" button (a clean, print-ready page with the yard
  name and a big code — opens in a new tab, nothing auto-prints), and a
  "Download PNG" button.
- **From `/superadmin`**: click "Show QR" on any yard's row for the same
  preview + printable page, without needing that yard's own admin password.

Worth knowing: the QR just encodes the public board link — the same link
you'd copy and paste — so there's nothing sensitive in it, and it doesn't
expire or need regenerating unless you rename the yard's slug.

**Any owner can pull it up too, not just admins.** The board itself
(`/y/:slug`) has an "Invite other owners" button right on it — no login,
same as booking a slot — which opens the same QR + copyable link. So if
someone's already on the board and wants to bring in another owner, they
don't need to hunt down whoever holds the admin password.

## Push notifications are correctly isolated per yard — and one real bug fixed

Two things worth knowing about how notifications work under the hood:

**Cross-yard isolation is real, not just assumed.** Every push subscription
is scoped by `yard_id`, and each yard registers its own service worker at
its own URL scope — so even the same physical phone/browser checking two
different yards ends up with two separate subscriptions under the hood. I
proved this by seeding a device with active subscriptions on two yards at
once and tracing exactly which subscription got selected for delivery on
each event: triggering something on one yard never even queries the
other yard's rows, regardless of any device identifiers being shared.

**A pre-existing bug, fixed**: the "targeted" notifications — share
request received, accepted, declined, and sharer-removed — were being
looked up by the wrong identifier (a random ownership-proof token instead
of the device's actual push identity), so they silently never delivered.
This predates the multi-yard rebuild; it was already like this in the
original single-yard app. Broadcast notifications (new booking,
cancellation) were never affected, since those already used the real
device token. Fixed now: bookings and share requests store the actual
device token of whoever created them, and the four affected notifications
use that instead. Tested end-to-end with real device tokens to confirm
delivery now actually targets the right person.

## Subscription / expiry tracking

Each yard can have a "paid until" date, set from `/superadmin`:

- Set it when creating a yard, or any time after from that yard's row —
  there's a date picker plus quick "+1 month" and "+1 year" buttons so you
  don't have to work out dates by hand.
- **Extending is renewal-aware**: if a yard's already paid up to next March
  and you click "+1 year" today, it lands on next-March-plus-a-year, not
  today-plus-a-year — clicking it a bit early doesn't cost the yard time.
- Leave it blank for no expiry (the default — nothing changes for yards
  that existed before this feature; they just have no expiry set).
- **Once the date passes, the board actually goes offline** — deactivating
  a yard has the same effect. Booking, sharing, and push all stop
  responding until it's reopened. It's not just a reminder.
- The yards list shows a status badge (Active / Expires soon / Expired)
  and how many days are left, so you can see at a glance who needs
  chasing for renewal.
- **Suspended boards show a real message, not a broken page.** Someone
  landing on a lapsed or deactivated yard's link sees "This board's
  subscription has ended — contact [SUPPORT_CONTACT] to renew," not a
  blank error. A yard that never existed still gets the generic "check
  the link" message — the two are told apart automatically.
- **The yard's own admin can still log in when suspended** — booking is
  blocked, but admin login isn't, specifically so they can see why and get
  in touch to renew rather than being locked out of even checking. Once
  logged in they see a status banner: a quiet "Subscription active until
  X" note if things are fine, amber if it's within 14 days of expiring,
  and red if it's expired or the yard's been deactivated.

Setting the expiry date itself is superadmin-only — yards can't edit their
own expiry date, just see it.

## Migrating your existing yard

If you point `DB_PATH` at your **current** `yardbook.db` (the single-yard
one), the app detects the old schema on first boot and auto-migrates:

- Creates a yard called **"Default Yard"** at slug `default`, admin password
  `changeme`.
- Attaches every existing booking and push subscription to it.
- Nothing is deleted or renamed — the migration only adds a `yard_id` column
  and backfills it.

After that first boot, go to `/y/default/admin`, log in with `changeme`,
and:
- Change the admin password
- Rename it from "Default Yard" to whatever the yard's actually called
- Optionally ask me to change the slug from `default` to something nicer —
  that's a superadmin-only rename I didn't wire into the UI yet, since slugs
  double as the booking link everyone's bookmarked, so it's worth doing
  deliberately rather than from a text field.

I'd suggest doing this on a **copy** of the live DB first, not the original,
so you can check it over before pointing the real deploy at it.

## What's different from the old single-yard version

- Booking hours (6am–9pm before) are now per-yard, editable from each yard's
  admin page — no more editing `SLOT_START_HOUR` in code.
  "Arena name" (was hardcoded "The School") is also per-yard.
- Push notifications are scoped per yard — a device only gets pinged for
  the yard whose board it's actually looking at, even if the same phone is
  used to check two different yards.
- The board now redirects `/y/:slug` → `/y/:slug/` (trailing slash) on first
  load — this is deliberate, not a bug, so bookmarks and home-screen
  installs land on a URL the service worker actually controls.

## Not built yet (flagged, not forgotten)

- **Per-yard branding** (logo upload, colour tweaks) — every yard currently
  shares the same chalkboard look and default horseshoe icon. Doable later
  if a yard wants their own logo.
- **Custom domains per yard** — out of scope for a path-based setup; would
  need a different routing approach if you ever want e.g.
  `booking.oakfieldlivery.co.uk`.
- **Slug renaming from the UI** — see migration note above.
