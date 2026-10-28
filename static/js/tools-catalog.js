/** Group headings of the Tools sheet, in display order. */
export const TOOL_GROUPS = Object.freeze([
  'Babies and children',
  'Heart, blood pressure and sugar',
  'Breathing and heart failure',
  'Test results',
  'Medicines and staying safe at home',
  'After a hospital visit',
]);

const [KIDS, HEART, BREATH, TESTS, HOME, AFTER] = TOOL_GROUPS;
const tool = (title, launch, subtitle, group, who, chunk) => ({ title, launch, subtitle, group, who, chunk });

/** key -> { title, launch (chat button text), subtitle, group, who (audience), chunk (lazy group module) }. */
export const TOOL_CATALOG = Object.freeze({
  child_dose_check: tool('Child fever-medicine amount', 'See the syringe picture', 'The amount printed on US labels for a weight band', KIDS, 'Children 3 months to 11 years', 'child'),
  growth_percentile: tool('Growth percentiles', 'See it on the growth curve', 'Weight, length or head size on WHO and CDC charts', KIDS, 'Children from birth to 20 years', 'child'),
  ors_planner: tool('Oral rehydration planner', 'See the rehydration plan', 'How much to offer after loose stools or vomiting, with a timer', KIDS, 'Children with mild diarrhoea or vomiting', 'child'),
  bp_log_summary: tool('Home blood pressure log', 'See the blood pressure bands', 'Keep readings and see morning and evening averages', HEART, 'Adults checking home readings', 'logs'),
  glucose_log_pattern: tool('Glucose pattern view and A1c', 'See the glucose pattern', 'Plot readings by time of day and convert an A1c', HEART, 'Adults who check their glucose', 'logs'),
  peak_flow_zone: tool('Peak-flow zone', 'See the zone', 'Place a peak-flow reading in the green, yellow or red zone', BREATH, 'People with asthma who have a personal best', 'logs'),
  hf_weight_zone: tool('Daily weight check', 'See the weight change', 'Compare today with yesterday and last week', BREATH, 'People with heart failure', 'logs'),
  lab_result_reader: tool('Read a lab result', 'See the reference range', 'Place a value against the range printed on your report', TESTS, 'Anyone with a lab report', 'logs'),
  medication_schedule: tool('Medication schedule sheet', 'Make a medication sheet', 'A printable grid of what each label says and when', HOME, 'Anyone taking several medicines', 'sheets'),
  steadi_fall_risk: tool('Fall-risk checklist (CDC STEADI)', 'See the fall-risk score', 'Twelve questions from the CDC Stay Independent checklist', HOME, 'Adults 65 and over, and their families', 'sheets'),
  when_to_call: tool('When-to-call sheet', 'Make a when-to-call sheet', 'A printable page of warning signs and who to call', AFTER, 'People going home after a hospital visit', 'sheets'),
});

/** The catalogue entry for a tool key, or null for anything unknown. */
export const toolFor = key => (typeof key === 'string' && Object.hasOwn(TOOL_CATALOG, key) ? TOOL_CATALOG[key] : null);
