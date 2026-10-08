# AJ Power Today and payroll interactive preview

Unzip the download and open **payroll-interactive.html** in Chrome, Edge, Firefox or Safari. No installation, server or internet connection is needed. If a file viewer only shows a screenshot, download the ZIP first and open the extracted HTML in a browser.

This is a review preview with five fictional active employees. Your uploaded employee report is not included. All changes stay in memory; **Reset preview** or reloading the page restores the examples.

Use the tabs at the top to try:

1. **Today:** current headcount bars and approvals sit side by side. Filter a site to see departments and that site’s single filled attendance graph. Open a bar/count to see people.
2. **Salary:** the compact card above revisions contains both pay group and salary structure. Apply a structure, edit salary, and choose an effective month and year. A sole salary can be edited; it cannot be deleted.
3. **Statutory:** deductions appear on the left, the selected income-tax regime on the right, and declarations directly below it. Switch New/Old regime and save declarations. Expand the tax breakdown only when needed.
4. **Pay groups:** manage employees, add existing employees to a group or move selected employees to another group. Create or edit a group and choose policies from dropdowns, including **None**.
5. **Salary structures:** create a structure. Basic, HRA and DA are included by default; DA can be removed. The breakup updates as you change components.
6. **Overtime policy:** choose Gross or select Basic, HRA and DA in any combination. Review the worked example and create a sample policy.
7. **Employee journey:** use **Edit details** to change a designation, then see that change in the journey.

Try **Meera Example** to edit one existing salary. **Ravi Sample** demonstrates a salary already used in paid July payroll: Edit lets you update salary from an available month, while the original salary and paid payroll remain intact. **Dev Sample** has no salary yet so you can try adding the first one.

Other navigation links lead to a preview information screen. Today’s attendance uses fictional sample counts. Your actual monthly attendance will be added after you provide it.

The preview does not save to the application or publish changes to GitHub.

## Rebuild for review

From the repository root, run `npm run build --workspace=@ajpwer/frontend`, then `node docs/designs/build-payroll-preview.cjs`. The output is a single HTML with scripts, styles and fonts embedded. Font license notices are in `payroll-preview-font-licenses.txt`.
