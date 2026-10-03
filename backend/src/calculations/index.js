/**
 * The engines are pure. Every function here takes data and returns data,
 * touches no database and reads no clock — the clock is passed in. This is
 * what lets a payroll run be reproduced months later.
 */
export * from './attendance/index.js';
export * from './leave/index.js';
export * from './pay/index.js';
export * from './statutory/index.js';
export * from './settlement/index.js';
