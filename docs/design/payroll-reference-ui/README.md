# AJPower payroll — reference-led visual proposal

Prepared 2 November 2026, India time. Design preview only, with sample data; no application source changes or implementation commit.

This visual proposal follows the user's Keka screenshot: purple application bar, slim icon rail, period cards, two overview tiles, a graphical verification summary, payroll cost chart with employee count, and a Need Attention panel. The external marketing website, Keka branding, BMW details and US payroll settings are not copied into the product.

AJPower uses its own company names, monthly cycles, INR amounts and PF / ESI / PT / TDS reports.

## Approved flow retained

- Generated month: saved figures and all twelve reports, with lock / regenerate in the header.
- Locked month: unlock and mark paid in the header.
- Draft month: current-month cash totals are replaced with review counts and blocking checks. Six graphical review points are accessible independently.
- Generate payroll stays in the header. Required reviews and blocking validation remain in place.
- Unlock, then Regenerate: confirm return to the same month's draft reviews, then explicitly generate again after review.
- Reports are shown as downloads below the dashboard; the main overview does not open as a spreadsheet.

## Pictures for approval

- 01-draft-reference-style.png
- 02-generated-reference-style.png
- 03-locked-reference-style.png
- 04-regenerate-reference-style.png

The preceding v1 and v2 visual treatments were rejected by the user; do not implement them. This reference-led version is awaiting visual review. Audio-training packaging/publication remains on hold; its 19 narrated videos are saved separately and passed audio checks.

## Branch scope

Saved on `feature/payroll-reference-ui` as a frontend design prototype, not a wired application implementation. The default branch and backend remain unchanged.

The current backend requires previous reviews to be submitted before later reviews can be confirmed. Opening reviews independently is a frontend concern; confirming them independently would require a separate backend change. That change is not included in this branch.

View the PNGs directly on GitHub. To try the standalone navigation locally, serve this directory with a local HTTP server and open `index.html`.
