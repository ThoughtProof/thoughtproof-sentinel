/**
 * Payment Adapter Index
 *
 * Re-exports all payment adapters for clean imports.
 */

export { X402PaymentAdapter } from './x402.js';
export type { X402Config } from './x402.js';
export { StripePaymentAdapter } from './stripe.js';
export type { StripeConfig } from './stripe.js';
