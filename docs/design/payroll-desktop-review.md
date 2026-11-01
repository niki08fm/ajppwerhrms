# Payroll desktop review — approved

Status: the user reviewed the before/after comparison and approved committing
and merging the changes on 2 November 2026 (Asia/Calcutta).

Baseline: `8c30118`. Six screens were captured before the application edits, then
captured again using the same fictional employees, month and 1440 × 1050 viewport:
month overview, attendance, employee checks, one-time adjustments, generation,
and the salary register. The artifact `ajpower-payroll-review/review.html` offers
swipe and side-by-side comparison, full-size PNG links and screen-specific notes.
These are actual browser captures, not generated UI mockups.

## Visible changes

- One month-and-totals panel, followed by one primary next action.
- All seven stages stay visible. The overview has a descriptive checklist;
  review pages use a compact stage navigator with fewer repeated status labels.
- Due dates remain visible. The historical cost chart opens on request.
- Consistent sans-serif headings, sentence-case figure labels, quiet table
  striping and a more specific confirmation footer.
- Reports name the month, company and saved snapshot. Regeneration and discard
  move to More actions, with explanations before either action changes data.
- Generated payroll is labelled “Generated · not locked”. The payment form
  explains that it records a completed transfer rather than sending money.

## Behavior fixes

- Generation start failures and failed background jobs retain their reason on
  the page. A job-status read error offers a retry without claiming failure.
- Pending finalisation/payment dialogs keep their inputs fixed and stay open.
  Payment errors retain the entered reference for a deliberate retry.
- Generation, holds, exclusions, adjustments, settlement choices and payment
  controls follow the existing permissions; server permissions are unchanged.
- Held-salary and loan-plan read failures prevent confirmation of partial reviews.
- Downloads wait for a usable report and current search filter. Export failures
  remain visible beside that report rather than appearing only in a toast.
- A missing/unrun previous payroll is not fetched by default or drawn as a
  generated historical cost. This was caused by an undefined enabled flag using
  the summary hook's default of true.
- A company-filtered review explicitly says that confirmations cover both
  companies; the filter scopes overview totals and report downloads.

## Verification and scope

32 Chromium browser checks passed, including the complete six-review → generate
→ reports → lock → payment journey, permission boundaries, data-read failures,
job failure feedback, pending saves, retained payment references, report/ZIP
navigation and the six matching screenshots. The production frontend build and
whitespace check passed. The comparison gallery's six screen choices, layout
switch and keyboard-operable slider were checked in Chromium.

No production data was read or written for this review. Tests intercept API
requests with fictional responses; payment and generation actions never reach a
real payroll service. Payroll calculations, statutory rates and server endpoints
were not changed. A future rollout would be a frontend deployment only.
