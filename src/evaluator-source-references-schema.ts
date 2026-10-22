/** Unsigned, host-derived reference diagnostics; no raw rejected identifiers or source text. */
export const evaluatorSourceReferencesSchema = {
  type: 'object', additionalProperties: false,
  description: 'The model explicitly selects a source address; the host resolves it before unchanged provenance and scoring checks. This records text identity, not truth, relevance or approval. Offsets are zero-based, end-exclusive UTF-16 positions in the original source.',
  required: ['schema_version', 'catalog_entries', 'catalog_truncated', 'citations'],
  properties: {
    schema_version: {type: 'string', enum: ['plv.source-references.v1']},
    catalog_entries: {type: 'integer', minimum: 0, maximum: 256},
    catalog_truncated: {type: 'boolean'},
    citations: {type: 'array', maxItems: 128, items: {
      type: 'object', additionalProperties: false,
      required: ['step_id', 'status', 'source', 'source_sha256', 'reference_id', 'start', 'end'],
      properties: {
        step_id: {type: 'string', description: 'Expected host step ID only.'},
        status: {type: 'string', enum: ['resolved', 'direct_quote', 'none', 'invalid']},
        source: {type: 'string', enum: ['trace', 'answer']},
        source_sha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        reference_id: {type: ['string', 'null'], description: 'Valid host address only. Unknown model IDs remain null.'},
        start: {type: ['integer', 'null'], minimum: 0},
        end: {type: ['integer', 'null'], minimum: 0},
      },
    }},
  },
};
