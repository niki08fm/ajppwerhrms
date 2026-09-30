# Try it: AJPWER Workforce with sample data

A complete copy of the system on your own computer, preloaded with rough data, so you can try everything — structures, CTCs, onboarding, attendance and a full payroll run — without touching real employee data.

## 1. Start it (one command)

You need **Docker Desktop** ([download for Windows or Mac](https://www.docker.com/products/docker-desktop/)) running, with about 4 GB of memory free.

In the project folder:

```bash
docker compose -f docker-compose.demo.yml up --build
```

The first start takes a few minutes: it builds the app, creates the database and loads the sample data. It is ready when the log shows the server listening. Then open:

**http://localhost:4000** — sign in as **hr@ajpwer.in** / **Demo@12345**

Nothing to configure: the demo carries its own settings. They are public demo values — never put real employees into this copy.

| To… | Run |
| --- | --- |
| Stop it (data is kept) | `Ctrl+C`, or `docker compose -f docker-compose.demo.yml stop` |
| Start it again | `docker compose -f docker-compose.demo.yml up` |
| Throw everything away and start over with fresh sample data | `docker compose -f docker-compose.demo.yml down -v` then `up --build` again |
| Use another port (if 4000 is busy) | `DEMO_PORT=4100 docker compose -f docker-compose.demo.yml up --build` and open http://localhost:4100 |

## 2. What is already loaded

The sample data is laid out around **today's date**, so it always looks current:

- **About 30 people** across departments, pay groups, sites and two PT states (Andhra Pradesh, Telangana), some agreed on gross and some on CTC, with PF and ESI switched on and off in different combinations.
- **Four months of attendance** from face punches at four sites (Alpha, Beta, Gamma, Head office).
- **Payroll:** the months three and two months back are **run, locked and paid**; **last month is ready to run**; **this month** is in progress.
- **Structures:** *Site staff* (Basic 50% of gross), *Office staff* (Basic 40% of gross, with a yearly bonus) and *Managers (CTC based)* (Basic 40% of CTC, HRA capped at ₹20,000).
- Deliberate problems for the payroll checks to catch: a joiner with no bank account, a leaver near the gratuity threshold, a loan large enough to hit the recovery cap, an expired document, a worked holiday and Sunday, a cross-site worker.

## 3. A guided tour

Each step stands on its own; do them in any order.

### A. Build a salary structure
1. **Setup → Salary structures → New structure.**
2. For each component: type the **name**, choose **Percentage** or **Fixed**, and for a percentage choose what it is **of — Gross, CTC or Basic**. Add a **Maximum** if you want a cap (there is no minimum).
3. The **Special Allowance** is added for you, last, and takes whatever is left of gross.
4. On the right, the **Salary breakup** shows Earnings → Gross, Company contributions → CTC, Deductions → Net pay. Switch the sample between **Monthly gross** and **Annual CTC** (try ₹4,00,000), and turn **PF** and **ESI** on and off to see the difference.
5. **Create structure.**

### B. Put a pay group on it
1. **Setup → Pay groups →** open a group **→** step **Salary structure** → pick your new structure.
2. Choose the **month it starts**. You see who moves (and anyone who cannot, with the reason) before saving.
3. Finish the wizard: everyone in the group is paid on the new structure from that month; each person's **Salary history** shows the change.

### C. Onboard someone on a CTC
1. **People → Offers and onboarding → Issue an offer.** Choose the pay group, **Offered as: Annual CTC**, and enter e.g. ₹4,00,000. The salary breakup updates as you type.
2. **Mark accepted**, then **Start onboarding** — the salary record now runs from the joining date.
3. Open the person and work through the **Onboarding checklist** (personal details, PAN/Aadhaar, bank, pay, joining letter, face). **Face enrolment** uses your computer's camera — you can enrol your own face.
4. **Activate** once the required items are done.

Or skip the offer: **People → Add existing employee**.

### D. Attendance
- **Attendance → Register:** the month for everyone. Click a day to see the punches, and **correct** it — a correction needs a reason, is kept beside the computed value, and can be reverted.
- **Overtime**, **Leave** and **Approvals** hold the requests waiting for a decision.

### E. Run payroll for last month
1. **Payroll → Run payroll** → last month.
2. Go through the five steps: **Submit attendance — freeze the month**, **Submit joiners and exits**, **Submit adhoc items**, **Submit issues** (blocking issues, like the joiner with no bank account, must be fixed or the person held back), then **Run**.
3. Check the **payslips** and the **reports** (salary register, bank file, PF, ESI, PT, TDS…), both on screen and as Excel.
4. **Lock**, then **Mark paid** with a payment reference. Every step can be taken back, and every change is in **Setup → Audit log**.

### F. The site tablet (optional)
Punches need the tablet to be inside a site's boundary, so make a site where you are:
1. **Sites → Add site** → use your location → note the tablet login it shows once.
2. Open **http://localhost:4000/tablet** (a second browser window works), sign in with that login, and allow location and camera.
3. Enrol a face (step C) and punch in. The punch appears in the register.

## 4. Things to know
- Income tax in the samples is on the new regime with no declarations; PT follows each person's state.
- **Company contributions** are employer PF 12% and, when eligible (gross ₹21,000 a month or less), employer ESI. EDLI and PF admin charges are paid with the PF challan but are not part of CTC.
- The PF ceiling is ₹25,000 (Setup → Statutory rules), so the most anyone contributes is ₹3,000, matched by the company.
- Yearly components and the bonus policy are still to be decided; the *Office staff* bonus is only an example.
