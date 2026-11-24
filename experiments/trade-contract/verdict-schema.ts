/**
 * Frozen model-output schema. Same fields and closed sets as the adapter parser.
 * Local parsing remains the final gate. xAI strict json_schema requires
 * additionalProperties false and every property listed in required.
 * Nulls use anyOf, which the structured-outputs guide allows.
 */
export const VERDICT_SCHEMA_ID = 'trade-contract-adapter-output/v1';

const id = { type: 'string', minLength: 1, maxLength: 256 };
const text = { type: 'string', maxLength: 2_000_000 };
const quote = {
  type: 'object',
  additionalProperties: false,
  required: ['documentId', 'quote'],
  properties: { documentId: id, quote: text },
};
const quoteList = { type: 'array', maxItems: 1024, items: quote };
const idList = { type: 'array', maxItems: 1024, items: id };
const nullableQuote = { anyOf: [{ type: 'null' }, quote] };
const nullableText = { anyOf: [{ type: 'null' }, text] };
const nullableId = { anyOf: [{ type: 'null' }, id] };
const binding = {
  type: 'object',
  additionalProperties: false,
  required: ['subjectId', 'measureId', 'unit', 'referenceId'],
  properties: { subjectId: id, measureId: id, unit: id, referenceId: id },
};
const numberReading = { type: 'string', enum: ['unambiguous', 'ambiguous', 'undetermined'] };
const quantity = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'binding', 'value', 'numberReading', 'valueQuote', 'bindingQuotes', 'referenceQuote'],
  properties: {
    id, binding, value: id, numberReading, valueQuote: quote, bindingQuotes: quoteList, referenceQuote: nullableQuote,
  },
};

export const VERDICT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'version', 'complete', 'applicability', 'detection', 'requirements',
    'semanticChecks', 'claims', 'quantities', 'limits',
  ],
  properties: {
    version: { const: 'trade-contract-adapter/v1' },
    complete: { type: 'boolean' },
    applicability: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['checkId', 'status', 'basis', 'documentIds', 'complete'],
        properties: {
          checkId: { type: 'string', enum: ['decision_basis', 'order_strategy_consistency', 'mandate_compliance', 'additional_claims', 'numeric_limits'] },
          status: { type: 'string', enum: ['applicable', 'not_applicable', 'undetermined'] },
          basis: { type: 'string', enum: ['mandatory', 'explicit_items', 'none_in_complete_scope', 'undetermined'] },
          documentIds: idList,
          complete: { type: 'boolean' },
        },
      },
    },
    detection: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['checkId', 'state', 'result'],
        properties: {
          checkId: { type: 'string', enum: ['mandate_compliance', 'numeric_limits', 'additional_claims'] },
          state: { type: 'string', enum: ['complete', 'incomplete', 'uncertain'] },
          result: { type: 'string', enum: ['found', 'none'] },
        },
      },
    },
    requirements: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'sourceHeading', 'decidedBy', 'quotes'],
        properties: {
          id,
          kind: { type: 'string', enum: ['strategy', 'mandate'] },
          sourceHeading: nullableText,
          decidedBy: { type: 'string', enum: ['clause', 'section_heading', 'undetermined'] },
          quotes: quoteList,
        },
      },
    },
    semanticChecks: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['checkId', 'status', 'quotes', 'requirementIds'],
        properties: {
          checkId: { type: 'string', enum: ['decision_basis', 'order_strategy_consistency', 'mandate_compliance'] },
          status: { type: 'string', enum: ['fulfilled', 'contradicted', 'not_verifiable', 'not_applicable'] },
          quotes: quoteList,
          requirementIds: idList,
        },
      },
    },
    claims: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'status', 'claimQuote', 'supportingQuotes', 'calculation'],
        properties: {
          id,
          kind: { type: 'string', enum: ['source_fact', 'inference', 'calculation', 'unsubstantiated_new_fact'] },
          status: { type: 'string', enum: ['fulfilled', 'contradicted', 'not_verifiable'] },
          claimQuote: quote,
          supportingQuotes: quoteList,
          calculation: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['operation', 'leftId', 'rightId', 'resultId'],
                properties: {
                  operation: { type: 'string', enum: ['add', 'subtract'] },
                  leftId: id,
                  rightId: id,
                  resultId: id,
                },
              },
            ],
          },
        },
      },
    },
    quantities: { type: 'array', maxItems: 1024, items: quantity },
    limits: {
      type: 'array',
      maxItems: 1024,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'binding', 'value', 'numberReading', 'valueQuote', 'bindingQuotes', 'referenceQuote', 'operator', 'quantityId'],
        properties: {
          id,
          binding,
          value: id,
          numberReading,
          valueQuote: quote,
          bindingQuotes: quoteList,
          referenceQuote: nullableQuote,
          operator: { type: 'string', enum: ['<', '<=', '>', '>=', '=='] },
          quantityId: nullableId,
        },
      },
    },
  },
} as const;
