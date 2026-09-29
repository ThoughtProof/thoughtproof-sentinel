/** OpenAPI for bounded, unsigned diagnostics. No untrusted field names or values are public. */
const valueTypes=['absent','null','boolean','number','string','array','object'];
const field={type:'object',additionalProperties:false,required:['type','state'],properties:{
  type:{type:'string',enum:valueTypes},state:{type:'string',enum:['missing','wrong_type','empty','out_of_range','non_finite','valid']},
}};
const fields={type:['object','null'],additionalProperties:false,required:['score','reasoning','quote'],properties:{score:field,reasoning:field,quote:field}};
const row={type:'object',additionalProperties:false,required:['position','type','step_id','id_status','fields','nested'],properties:{
  position:{type:'integer',minimum:0},type:{type:'string',enum:valueTypes},step_id:{type:['string','null'],description:'Expected host step ID only; an unknown model ID is never echoed.'},
  id_status:{type:'string',enum:['known','unknown','missing','wrong_type','not_object']},fields,
  nested:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['container','type','fields'],properties:{
    container:{type:'string',enum:['assessment','evaluation','result']},type:{type:'string',enum:valueTypes},fields,
  }}},
}};
export const evaluatorShapeSchema={type:'object',additionalProperties:false,
  description:'Optional structure-only diagnostic. At most eight row samples in total across the root and known containers, at most three known child fields per row. No raw model text, field values, arbitrary keys or unknown IDs. Sampling never changes validation or repairs data.',
  required:['schema_version','json','root_type','expected_steps','root_items','recognized_steps','rows','containers','truncated'],
  properties:{
    schema_version:{type:'string',enum:['plv.evaluator-shape.v1']},json:{type:'string',enum:['parsed','invalid']},
    root_type:{type:'string',enum:[...valueTypes,'unparsed']},expected_steps:{type:'integer',minimum:0},root_items:{type:['integer','null'],minimum:0},
    recognized_steps:{type:'integer',minimum:0},rows:{type:'array',maxItems:8,items:row},truncated:{type:'boolean'},
    containers:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['container','type','items','rows'],properties:{
      container:{type:'string',enum:['evaluations','assessments','results','steps','objections','result','evaluation','assessment']},
      type:{type:'string',enum:valueTypes},items:{type:['integer','null'],minimum:0},rows:{type:'array',maxItems:8,items:row},
    }}},
  },
};
