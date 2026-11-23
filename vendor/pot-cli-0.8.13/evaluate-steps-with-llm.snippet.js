async function evaluateStepsWithLLM(item, stepsToEvaluate, model, maxTokens, mode = 'support', nanoStepContract = false) {
    // ADR-0009: per-step EVIDENCE_SOURCE routing.
    // Steps with step_type='answer_consistency' must be evaluated against the
    // AGENT ANSWER (synthesis fidelity); everything else against the TRACE EXCERPT
    // (research support). Both sources are present in the prompt and the model
    // routes per the EVIDENCE_SOURCE marker. See `resolveEvidenceSource` for the
    // canonical mapping used downstream by provenance + score-floors.
    const stepsInput = stepsToEvaluate.map(s => {
        const criterion = s.acceptance_criterion ??
            `The trace must show evidence that this step was actually performed with verifiable output: "${s.description}"`;
        const evidenceSource = s.step_type === 'answer_consistency' ? 'answer' : 'trace';
        return `STEP_ID: step_${s.index}\nGOLD_STEP: ${s.description}\nCRITICALITY: ${s.criticality}\nEVIDENCE_SOURCE: ${evidenceSource}\nACCEPTANCE_CRITERION: ${criterion}`;
    }).join('\n\n');
    const userPrompt = `Evaluate ALL steps below.

Each step has an EVIDENCE_SOURCE field that tells you which section to use:
  - EVIDENCE_SOURCE: trace  → evaluate against TRACE EXCERPT (was the research performed?)
  - EVIDENCE_SOURCE: answer → evaluate against AGENT ANSWER (does the answer faithfully
    represent what the trace established? watch for conflation, omission, distortion).

Quotes in your output MUST come from the section the step's EVIDENCE_SOURCE points to.
Never quote the trace for an EVIDENCE_SOURCE=answer step, and vice versa.

QUESTION: ${item.question}

AGENT ANSWER:
${item.answer}

TRACE EXCERPT:
${item.trace_steps}

---

GOLD STEPS TO EVALUATE:
${stepsInput}

---

Return a JSON array with one evaluation object per step. ONLY JSON, no prose.`;
    // Strict suffix is additive and only for serv-nano faithfulness when Sentinel
    // opts in. The base FAITHFULNESS_EVALUATOR_PROMPT bytes stay in the module.
    const useNanoContract = nanoStepContract === true && mode === 'faithfulness' && isNanoModel(model);
    const systemPrompt = (mode === 'faithfulness'
        ? FAITHFULNESS_EVALUATOR_PROMPT
        : GRADED_SUPPORT_SYSTEM_PROMPT) + (useNanoContract ? NANO_STRICT_OUTPUT_SUFFIX : '');
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    const parse = (text) => {
        // Strip markdown code fences (models often wrap JSON in ```json...```).
        // Guard nullish text — empty/undefined provider content must not throw
        // on .replace (same failure class as omitted quote fields).
        const safeText = text == null ? '' : String(text);
        const stripped = safeText.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
        // Target [{ ... }] — the JSON-array-of-objects pattern.
        // This avoids false matches on prose brackets like [step 1] or [note: ...]
        // which cause greedy /\[[\s\S]*\]/ to grab prose+JSON as one blob.
        const start = stripped.indexOf('[{');
        const end = stripped.lastIndexOf('}]');
        if (start !== -1 && end !== -1 && end > start) {
            const parsed = JSON.parse(stripped.substring(start, end + 2));
            if (Array.isArray(parsed))
                return parsed;
        }
        // Fallback: original greedy regex (works for clean outputs)
        const match = stripped.match(/\[[\s\S]*\]/);
        if (!match)
            throw new Error('No JSON array found in response');
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed))
            throw new Error('Expected array');
        return parsed;
    };
    const callOpts = {
        parse,
        maxTokens,
        temperature: 0,
        seed: DEFAULT_EVAL_SEED,
    };
    // JSON-parse retries stay at pot-cli's existing 2. A parsed-but-malformed
    // nano step gets one extra call with the strict contract, then throws so
    // the cascade takes primary_error_fallback (fail-closed, never ALLOW).
    const first = await callModelStructured(model, messages, { ...callOpts, retries: 2 });
    if (!useNanoContract)
        return first.data;
    let normalized = normalizeNanoStepArray(first.data);
    if (!normalized.malformed)
        return normalized.steps;
    const retry = await callModelStructured(model, [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: `${userPrompt}\n\nYour previous reply was malformed (${normalized.reasons.join('; ')}). Reply again with ONLY the strict JSON array.${NANO_STRICT_OUTPUT_SUFFIX}`,
        },
    ], { ...callOpts, retries: 0 });
    normalized = normalizeNanoStepArray(retry.data);
    if (normalized.malformed)
        throw new MalformedNanoStepError(normalized.reasons);
    return normalized.steps;
}
