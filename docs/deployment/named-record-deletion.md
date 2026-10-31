# Delete employees, salary structures and pay groups

Deletion removes a record from active lists and new assignment choices. It keeps paid payslips, attendance, salary revisions, offers, documents and audit history linked to their original IDs. It is not a permanent erasure or the normal exit/F&F workflow. Employee codes and pay-group names remain reserved by their historical records.

## Employee

1. Open **Employees**, then the employee's profile.
2. Select **Delete employee**. People write and salary write permissions are required.
3. Review the employee name/code and the effects. Unpaid payroll, unresolved held salary, open F&F, outstanding loan/advance/recovery carry or running payroll blocks deletion; resolve the listed items first.
4. Type the complete employee name exactly as displayed, including capital letters and spaces.
5. Select **Delete employee**. The app returns to Employees. Their enrolled face templates are cleared and pending face-registration approvals are revoked. They cannot be selected for future payroll or face punching. Editable payroll review steps are reset so HR reviews the changed roster again.

For a normal employee departure, record their exit and complete F&F instead.

## Pay group

1. Open **Setup → Pay groups** and select the group's **Delete** action.
2. If employees still use it, select **Manage linked employees**.
3. Select the employees, choose another pay group, and select **Move selected employees**. Their salary structures stay unchanged.
4. Return to Delete and type the complete pay-group name to confirm.

Exited/deleted employees retain their historical group links. Old policy definitions are retained.

## Salary structure

1. Open **Setup → Salary structures** and select the structure's **Delete** action.
2. Select **Manage linked employees** to see current and future salary assignments.
3. Use **Change salary structure** beside each employee to enter a salary revision with another structure and the appropriate effective date. Existing salary protection rules still apply.
4. A future revision does not release the old structure until its current assignment ends. Change/remove any other future revisions that still use it. For an open hiring offer, revoke it in Hiring and issue a replacement offer with another structure; changing salary alone does not replace an offer.
5. When no current/future assignments or open offers remain, return to Delete and type the exact structure name.

Historical salary rows and structure components are retained. Setup write permission is required to delete setup records; people read permission is required to see linked employee details and salary write permission to change salaries.

## Deploy

No schema migration or dependency change is required. Update the AWS checkout and restart `ajpwer-api`, then deploy the same commit to the Vercel production frontend. The API rechecks assignments, financial blockers, permissions and the exact name at deletion time, including after an old confirmation preview.
