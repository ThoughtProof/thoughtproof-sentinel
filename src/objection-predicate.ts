/**
 * objection-predicate — re-export from @thoughtproof/fact-check-core.
 *
 * The predicate/gate logic was moved into fact-check-core (2026-07-07) so it
 * lives with the fact-check family and both trading-agent consumers can use it
 * without importing Sentinel. This file preserves Sentinel's original import
 * surface exactly — same symbols, same behavior — so nothing here changes.
 *
 * `VerifiedFactFlag` is kept as a local alias of the library's `PredicateInputFlag`
 * (the type was renamed in the move to avoid colliding with the core's own
 * VerifiedFactFlag, which models direction separately).
 */

export {
  predicateFromFlag,
  satisfiesPredicate,
  enforcementLevel,
  measureRevisedValue,
  checkRevision,
  type NumericObjectionKind,
  type ObjectionPredicate,
  type EnforcementLevel,
  type VerifiedMarketFacts,
  type MeasuredValue,
  type PredicateInputFlag as VerifiedFactFlag,
} from "@thoughtproof/fact-check-core/objection-predicate";
