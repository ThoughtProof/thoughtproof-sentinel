import { VERDICT_SCHEMA } from './verdict-schema.ts';

/**
 * Comparison request schema. The frozen VERDICT_SCHEMA bytes stay unchanged.
 * `grounding` is required and nullable so both arms send the same strict
 * object. Null means there are no grounding rows.
 */
const quote = {
  type: 'string',
  minLength: 1,
  maxLength: 2_000_000,
};
const groundingRow = {
  type: 'object',
  additionalProperties: false,
  required: [
    'objectionId',
    'clauseDocumentId',
    'clauseQuote',
    'evidenceDocumentId',
    'evidenceQuote',
    'reading',
  ],
  properties: {
    objectionId: { type: 'string', minLength: 1, maxLength: 256 },
    clauseDocumentId: { type: 'string', minLength: 1, maxLength: 256 },
    clauseQuote: quote,
    evidenceDocumentId: { type: 'string', minLength: 1, maxLength: 256 },
    evidenceQuote: quote,
    reading: { type: 'string', enum: ['met', 'violated', 'open'] },
  },
};

export const COMPARISON_SCHEMA_NAME = 'trade_contract_comparison_v1';

export const COMPARISON_SCHEMA = {
  ...VERDICT_SCHEMA,
  required: [...VERDICT_SCHEMA.required, 'grounding'],
  properties: {
    ...VERDICT_SCHEMA.properties,
    grounding: {
      anyOf: [
        { type: 'null' },
        { type: 'array', maxItems: 1024, items: groundingRow },
      ],
    },
  },
};
