const labels = {
  1: 'Attendance',
  2: 'Joiners and exits',
  3: 'Employee checks',
  4: 'Held salaries',
  5: 'Final settlements (F&F)',
  6: 'One-time adjustments',
  7: 'Generate payroll'
};
export const payrollStepLabel = step => labels[step] ?? `Step ${step}`;
/** Use the confirmed server state before navigating, so the next review never flashes back. */
export async function cachePayrollPeriod(queryClient, month, response) {
  const period = response?.data;
  if (period?.period_ym === month && Array.isArray(period.steps_submitted)) {
    await queryClient.cancelQueries({
      queryKey: ['period', month],
      exact: true
    });
    queryClient.setQueryData(['period', month], period);
    return true;
  }
  return false;
}
