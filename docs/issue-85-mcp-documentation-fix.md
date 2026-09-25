## MCP Documentation Fix for Issue #85

### Current Documentation (INCORRECT)

The current MCP tool documentation states that caller-declared kinds are "preferred":

```typescript
mandate_kind: z
  .enum(ACTION_KINDS)
  .optional()
  .describe(
    "Optional host-declared Sentinel ActionKind for the mandate (mandate.kind). " +
      "Values: informational | value_transfer | permission | deploy_ship | unknown. " +
      "Sentinel prefers this over prose classification. Omit rather than guess."
  ),
```

### Corrected Documentation (NARROWING-ONLY)

```typescript
mandate_kind: z
  .enum(ACTION_KINDS)
  .optional()
  .describe(
    "Optional host-declared Sentinel ActionKind for the mandate (mandate.kind). " +
      "Values: informational | value_transfer | permission | deploy_ship | unknown. " +
      "Caller kinds may narrow but NOT widen beyond prose classification. " +
      "Informational requires prose to also read as informational. Omit rather than guess."
  ),
action_kind: z
  .enum(ACTION_KINDS)
  .optional()
  .describe(
    "Optional host-declared Sentinel ActionKind for the proposed action (action.kind). " +
      "Values: informational | value_transfer | permission | deploy_ship | unknown. " +
      "Caller kinds may narrow but NOT widen beyond prose classification. " +
      "Informational requires prose to also read as informational. Omit rather than guess."
  ),
```

### Working Informational Example

**Correct phrasing that will ALLOW:**
```javascript
{
  mandate: "FYI team channel: Agenda für Meeting posten",
  proposed_action: "Post message with agenda content",
  mandate_kind: "informational",
  action_kind: "informational"
}
```

**Incorrect phrasing that will BLOCK (false_BLOCK):**
```javascript
{
  mandate: "Post agenda with settlement Day-14 #13 data to channel",
  proposed_action: "Post message with agenda content", 
  mandate_kind: "informational", // ← Caller declares informational
  action_kind: "informational"   // ← but prose contains no informational markers
}
```

### Key Rules

1. **Narrowing-only:** Caller `informational` + prose `unknown` = BLOCK
2. **Prose requirement:** Informational requires prose markers: `fyi`, `notify`, `inform`, `informiere`, `Bescheid`, `Status an`
3. **Cannot bypass:** FYI cannot bypass transfer gate - if prose suggests money movement, caller `informational` will block