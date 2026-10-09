# AJ Power Today and payroll interactive preview

Unzip the download and open **payroll-interactive.html** in Chrome, Edge, Firefox or Safari. No installation, server or internet connection is needed. If a file viewer only shows a screenshot, download the ZIP first and open the extracted HTML in a browser.

This is a review preview with five fictional active employees. Your uploaded employee report is not included. All changes stay in memory; **Reset preview** or reloading the page restores the examples.

Use the tabs at the top to try:

1. **Today:** current headcount bars and approvals sit side by side. Filter a site to see departments and that site’s single filled attendance graph. Open a bar/count to see people.
2. **Salary:** review the visual salary summary and scroll the revision history sideways inside its card. Anita has five revisions to compare. The compact card above revisions contains both pay group and salary structure. Apply a structure, edit salary, and choose an effective month and year. A sole salary can be edited; it cannot be deleted.
3. **Statutory:** deductions appear on the left. Choose the tax regime on the right, complete declarations above the selected tax view, and inspect the visual tax summary. 80C, 80D and HRA/rent fields appear only under Old regime. Switch to New to see the automatic standard deduction; expand the breakdown when needed.
4. **Payslips:** change the year using arrows or the year selector, then open a month in that year. Anita has 2025–2026 slips. Choose Ravi from **Sample employees** for ten years of paid examples (2017–2026); only the selected year's months appear. Amounts and earnings/deductions stay frozen when salary changes.
5. **Pay groups:** manage employees, add existing employees to a group or move selected employees to another group. Create or edit a group and choose policies from dropdowns, including **None**.
6. **Salary structures:** create a structure. Basic, HRA and DA are included by default; DA can be removed. The breakup updates as you change components.
7. **Overtime policy:** choose Gross or select Basic, HRA and DA in any combination. Review the worked example and create a sample policy.
8. **Employee journey:** use **Edit details** to change a designation, then see that change in the journey.

Try **Meera Example** to edit one existing salary. **Ravi Sample** demonstrates a sole salary already used in paid payroll through July 2026: Edit lets you update salary from an available month, while the original salary and paid payroll remain intact. **Dev Sample** has no salary yet so you can try adding the first one.

Other navigation links lead to a preview information screen. Today’s attendance uses fictional sample counts. Your actual monthly attendance will be added after you provide it.

The preview does not save to the application or publish changes to GitHub.

## Rebuild for review

From the repository root, run `npm run build --workspace=@ajpwer/frontend`, then `node docs/designs/build-payroll-preview.cjs`. The output is a single HTML with scripts, styles and fonts embedded. Font license notices are in `payroll-preview-font-licenses.txt`.
