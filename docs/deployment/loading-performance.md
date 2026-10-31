# Loading performance: approval register batching

The navigation badge and Today screen both read the shared HR approval list. Previously,
that list reconstructed seven daily attendance registers with separate employee, punch,
leave, holiday, override, transfer and pay-group reads for every date. Concurrent initial
requests could also perform the same work twice before the ten-second cache was filled.

The updated service reads the seven-day range once and shares pay-group rule promises,
then calls the existing day engine for each date. It groups punches, overrides and leave
by employee in memory. Employee join/exit boundaries are still applied separately on each
date; policy effective dates, frozen months, approved leave, holidays, HR corrections and
site travel retain the same treatment. No attendance or payroll formula was changed.

Concurrent Today/navigation requests share the pending approval calculation. Explicit
invalidation prevents an older calculation from refilling the cache after a mutation.
Failures can be retried, and requests for a different database/date/register are isolated.
Manual sheet deadlines continue to invalidate otherwise unexpired cached lists.

Validation: all 448 engine checks and 34 attendance/tablet/manual-sheet API checks pass.
The seven-day, one-pay-group regression fixture reduces the relevant model reads from
49 to 7 and matches independent daily register outputs. This is a query-work reduction,
not a measured sevenfold improvement in live page-load time. The live deployment was
not benchmarked from the development environment.

## Deploy on AWS

```sh
cd /opt/ajpwer
git pull --ff-only origin feature/clean-hrms-experience
sudo systemctl restart ajpwer-api
curl --fail http://127.0.0.1:4000/api/v1/health
```

This is backend-only: no Vercel promotion, database migration, dependency installation,
seed, employee reset or face-service restart is needed. Refresh Today after the API is
running. The health endpoint verifies the process, not database performance. Compare
opening Today/Approvals before and after this update under the same network and data.
If login, a report, or a different screen remains slow, measure that particular request
rather than assuming this change resolves every endpoint or changing cloud plans first.

## Follow-up: lighter navigation and shared dashboard reads

The sidebar now asks `/dashboard/people?summary=approvals` for just the approval count,
instead of waiting for the full people dashboard's employee pipeline, leavers, salary
holds, unpaid wages, document expiry and separate face/leave counts. The full endpoint
response remains available for existing callers. Sidebar fetching is disabled when the
signed-in user lacks its existing `people.read` permission; endpoint permissions remain
unchanged. Its query key stays under the existing dashboard/people invalidation prefix.

Dashboard cache entries now share a pending read as well as a completed result. TTL
starts when data becomes ready, failures are retryable and clearing the cache during
an attendance change prevents the old result from being reinserted. Overview also skips
an employee-name lookup when there are no moves/holds to name. Live attendance figures
and statutory calculations are unchanged.

Validation: 452 engine checks, 20 scoped API checks and 23 browser checks passed, plus
the production frontend build. Passive Prisma observation verifies that the badge omits
unrelated salary/document/people summary reads while matching the full Approvals count.
These tests show reduced work; they do not establish a live latency target.

For this follow-up, run the AWS update commands above **and** promote the new matching
frontend commit to Production in Vercel (or let the configured production branch deploy).
Then refresh the app. Unlike the first backend-only batching fix, the smaller sidebar
request needs the new frontend. No migration, reset or dependency installation is needed.
