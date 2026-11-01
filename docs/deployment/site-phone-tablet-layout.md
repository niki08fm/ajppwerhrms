# Site workspace on phones and tablets

The existing `/tablet` URL now adapts to site staff's phones and tablets. No new
app, login credentials or API is required. The general `/login` form still accepts
a site login ID and forwards the signed-in user to this workspace.

## Layout and touch behavior

- Phone and tablet navigation (up to 1366 px wide) has three sections: **Attendance**, **Registers** and **More**.
  Attendance opens with one large punch action. Registers switches between daily
  and monthly views. More contains manual attendance, transfers, registration,
  people on site, an expandable summary and sign out. Wider desktop screens keep tabs
  and the fuller dashboard. The touch home does not render charts; its reading
  width stays comfortable on larger tablets. Tablet navigation buttons stay
  grouped near the centre of the bottom bar.
- Phones show daily attendance as employee cards with punch times, status, worked
  hours, overtime, late/early minutes and punch counts. Monthly cards show totals
  and expandable daily punches, including punch-out-only records. Wider devices
  retain tables with contained horizontal scrolling and fixed employee columns.
- Only the applicable card or table layout is mounted. Rotating between layouts
  keeps the register search, department and pagination state.
- Site buttons, icon buttons and expandable summaries have a minimum 44 px touch
  target. Site form controls use 16 px text and date selectors fit narrow cards.
  Login fields support password managers without opening the keyboard on arrival.
- Long site names wrap without pushing Sign out offscreen. The main Punch action
  remains visible on the tested small-phone initial viewport.
- Camera guidance and controls sit outside the preview. In a short landscape
  viewport they move beside it; portrait keeps them beneath it. The face oval is
  still calculated from the preview's actual dimensions.
- Site dialogs track the visual viewport so their scrollable content and action
  footer can fit the space above a mobile keyboard. Safe-area padding accommodates
  screen cutouts and home indicators. Manual sheet submission stacks on phones.

## Verification

52 Chromium browser tests passed against the actual frontend with fictional site,
attendance and camera fixtures. The preceding shared-device update also passed
22 backend face-punch API tests using an isolated database and mocked face service. Coverage includes 320 × 568 and 390 × 844 phones,
768 × 1024, 1024 × 768 and 1366 × 1024 tablets, 844 × 390 camera rotation, short phone/tablet
transfer dialogs, manual sheets, face registration review and confirmed punching.
Checks cover page overflow, visible actions, register values, cancellation and
site-scoped request boundaries. The production frontend build and whitespace
check passed. Screenshots were inspected for phone and tablet layouts.

Camera tests simulate acquisition and frames; they do not measure biometric
accuracy, low-light recognition or physical-device camera behavior. The short
viewport checks approximate keyboard space and do not replace Safari/Android
hardware testing. Location, identity checks, confirmation and payroll rules are
unchanged by this UI update.

## Multiple employees and repeated visits

One site login can be shared by multiple employees taking turns to scan and confirm.
A successful punch now offers **Scan next person**, which starts a new capture
session and cancels the prior result's return timer. The next employee must still
confirm their own name and IN/OUT direction. Camera capture is sequential.

The existing backend already supports the same employee punching IN → OUT → IN
→ OUT at one site in a day. An API regression verifies two employees doing this on
one site login: 09:00–12:00 and 13:00–16:00 produce six worked hours per employee,
not seven. The existing two-minute accidental-rescan guard remains in place and
is per employee; it does not impose a delay between different employees. Repeated
requests and competing confirmations keep their duplicate protection.

Backend tests use an isolated local test database and a mocked face service. No
production attendance records or server rules were changed.

## Deployment

Deploy this commit to the AJPower Vercel frontend and promote it to production if
needed. Refresh the site workspace afterward. No API restart, database migration,
new device registration or employee face re-registration is needed.
