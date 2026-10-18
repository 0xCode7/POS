# Stage 8B/8C UI redesign

Stage 8B/8C replaces the accumulated screen styling with one Arabic-first RTL
design system while preserving every API contract, database migration, payment
calculation, and receipt value.

## Review findings

The before captures showed inconsistent spacing and radii, oversized page
headers, large unused areas on wide screens, symbol-based navigation, and a POS
checkout that fell below the fold at 1366×768. Authentication copy was partly
English, the compact layout could clip navigation labels, and modal focus did
not reliably return to its trigger.

## Implemented system

- Off-white application canvas, white surfaces, slate text, and a restrained
  deep-emerald accent are defined as reusable CSS tokens.
- IBM Plex Sans Arabic is bundled from the official OFL-licensed npm package.
  It is served by Vite/Express from local build assets; the application makes no
  font or CDN request at runtime. See `THIRD_PARTY_NOTICES.md`.
- The fixed RTL sidebar uses consistent local SVG icons and collapses to a
  compact navigation row. At phone widths it keeps accessible labels while
  displaying icons only to avoid clipping.
- The POS keeps categories and search close to the catalog, uses scannable item
  cards, exposes clear quantity controls, and keeps the order summary and
  checkout sticky on desktop. At narrower widths the panels stack naturally.
- Admin menu, users, reports, receipts, backup, login, and setup screens share
  form, card, status, feedback, and dialog patterns.
- Dialogs trap keyboard focus, close with Escape, and restore focus to the
  opening control. Focus indicators use `:focus-visible`.
- Receipt print rules remain independent from screen styling and retain the
  existing 80 mm/58 mm formats.

## Browser evidence

Before:

- [1366×768](../artifacts/stage8/before-1366x768.png)
- [1920×1080](../artifacts/stage8/before-1920x1080.png)

After:

- [390×844](../artifacts/stage8/after-390x844.png)
- [768×1024](../artifacts/stage8/after-768x1024.png)
- [1024×768](../artifacts/stage8/after-1024x768.png)
- [1366×768](../artifacts/stage8/after-1366x768.png)
- [1920×1080](../artifacts/stage8/after-1920x1080.png)
- [Menu at 1366×768](../artifacts/stage8/after-menu-1366x768.png)
- [Reports at 1366×768](../artifacts/stage8/after-reports-1366x768.png)

Chromium inspection at all five responsive widths reported equal document
`scrollWidth` and `clientWidth`, a loaded IBM Plex Sans Arabic face, no external
network request, and no failed request after authentication. The login page's
initial session probe can produce an expected local `401 Unauthorized` before a
user signs in; it does not indicate an application exception.

## Remaining verification

Browser print invocation is automated with a mock, but physical 58 mm/80 mm
printer output, Windows font rendering, touch hardware, and Windows packaging
remain unverified. They must not be inferred from browser screenshots.

## V2 operational-density pass

The V2 baseline retained the established visual system but exposed three
remaining desktop issues: the open-order area was taller than its information,
an empty daily-sales chart reserved almost the same height as a populated
chart, and the order column was visually weak beside the catalog at 1366 px.

The follow-up pass uses a 64/36 POS split, larger product hit areas, an action
inside the empty-order state, a compact inline open-order strip, shorter empty
report panels, and a reduced populated chart height. Cashiers can press `F2`
for a new order when none is selected and `/` to focus product search. These
shortcuts do not run while editing a field.

V2 baseline screenshots:

- [POS 1366×768](../artifacts/stage8-v2/before-v2-pos-1366.png)
- [POS 1920×1080](../artifacts/stage8-v2/before-v2-pos-1920.png)
- [Menu 1366×768](../artifacts/stage8-v2/before-v2-menu-1366.png)
- [Orders 1366×768](../artifacts/stage8-v2/before-v2-orders-1366.png)
- [Reports 1366×768](../artifacts/stage8-v2/before-v2-reports-1366.png)

V2 result screenshots:

- [POS 390×844](../artifacts/stage8-v2/after-v2-pos-390.png)
- [POS 768×1024](../artifacts/stage8-v2/after-v2-pos-768.png)
- [POS 1024×768](../artifacts/stage8-v2/after-v2-pos-1024.png)
- [POS 1366×768](../artifacts/stage8-v2/after-v2-pos-1366.png)
- [POS 1920×1080](../artifacts/stage8-v2/after-v2-pos-1920.png)
- [Menu 1366×768](../artifacts/stage8-v2/after-v2-menu-1366.png)
- [Orders 1366×768](../artifacts/stage8-v2/after-v2-orders-1366.png)
- [Reports 1366×768](../artifacts/stage8-v2/after-v2-reports-1366.png)

Automated Chromium inspection found no horizontal document overflow at 390,
768, 1024, 1366, or 1920 px. The bundled Arabic font loaded at every size, no
external request occurred, and no local request failed. The expected initial
unauthenticated session probe still returns `401` before login.

## Dedicated backup management

Backup operations now have an admin-only navigation destination instead of
sharing the sales report. Compact status cards, a bidirectional path display,
validated history table, manual creation state, safe directory configuration,
and explicit offline-restore messaging reuse the same RTL design system.

- [390×844](../artifacts/backup-management/backups-390.png)
- [768×1024](../artifacts/backup-management/backups-768.png)
- [1366×768](../artifacts/backup-management/backups-1366.png)
- [1920×1080](../artifacts/backup-management/backups-1920.png)
