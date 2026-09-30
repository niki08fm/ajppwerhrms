/**
 * The engines are pure. Every function here takes data and returns data,
 * touches no database and reads no clock — the clock is passed in. This is
 * what lets a payroll run be reproduced months later.
 */
export * from './attendance';
export * from './pay';
export * from './statutory';
export * from './settlement';
