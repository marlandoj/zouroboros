/**
 * Zouroboros Core
 * 
 * Core types, constants, and utilities shared across all Zouroboros packages.
 * 
 * @module zouroboros-core
 */

export * from './types.js';
export * from './constants.js';
export * from './paths.js';
export * from './config/loader.js';
export * from './config/schema.js';
export * from './backup.js';
export * from './errors.js';
export * from './migrations.js';
export * from './hooks.js';
export * from './token-budget.js';
export * from './commands.js';
export * from './shortcuts.js';
export * from './sessions.js';
export * from './instincts.js';
export * from './adapters/index.js';
export * from './compute.js';

// Version
export const VERSION = '2.0.0';
