# Design: checkRevision-Verdrahtung (Mechanismus → aktives Gate)

*Status: DESIGN (kein Code). 2026-07-07. Zwei Repos: thoughtproof-sentinel + verified-trading-agent.*

## Ziel

Das objection-binding predicate-gate (checkRevision, gemergt in Sentinel PR #15) vom
MECHANISMUS zum AKTIVEN Gate machen: bei einem Re-Plan prüft die Pipeline die revidierte
Entscheidung deterministisch gegen das falsifizierbare Prädikat der gehaltenen Objection —
statt nur ein frisches Modell-Urteil zu fällen.

## Der Datenfluss HEUTE (verifiziert, wo die strukturierten Werte verloren gehen)

Es gibt DREI Stellen, an denen die strukturierten {claimedValue, actualValue} verflacht werden
— nicht nur eine. Das ist der Kern des Problems:

1. **fact-check (VTA/cb4a):** erzeugt Flags. Nach der fact-check-core-Anbindung HABEN die Flags
   jetzt {claimedValue, actualValue} (cb-stack) bzw. der VTA-Wrapper narrowt sie noch auf
   {kind, evidenceLine} (bewusst, für Interface-Kompat). → Werte da in der Lib, im VTA-Wrapper
   aktuell weggenarrowt.
2. **Sentinel /sentinel/verify objections (engine/index.ts:159):** die Objections tragen
   {step_id, criterion, score, predicate, quote, reasoning} — ABER KEINE claimedValue/actualValue.
   Der predicate-Wert ist ein String-Label ('faithful' etc.), NICHT das strukturierte Prädikat.
   → Sentinel-Output hat das Prädikat gar nicht in verwertbarer Form.
3. **VTA verification.ts:58 + main.ts:167:** was von Sentinel kommt, wird auf
   {severity, explanation} (Prosa) reduziert, und im replan-loop weiter auf explanation-Strings.
   → letzte Reste Struktur weg.

## Konsequenz: checkRevision kann NICHT einfach "eingehängt" werden

checkRevision(predicate, measuredValue) braucht (a) ein ObjectionPredicate {field, op, value}
und (b) einen gemessenen revisedValue. HEUTE existiert (a) an KEINER Stelle im Live-Datenfluss
als strukturiertes Objekt — es müsste aus den fact-check-Flags konstruiert werden (die es nach
der Lib-Anbindung haben), NICHT aus den Sentinel-Objections (die es nie hatten).

→ Das ändert die Architektur-Entscheidung: das predicate-Gate gehört NICHT in den Sentinel-
verdict-path (dort gibt es die numerischen Rohwerte nicht), sondern in den VTA/cb4a-REPLAN-LOOP,
direkt neben den fact-check-Flags, die die strukturierten Werte tragen.

## Ziel-Architektur (wo checkRevision einhakt)

Ort: verified-trading-agent/src/main.ts, im firstBlocked-replan-Zweig (Zeile 163-193),
NACH replanAfterBlock + revisedVerification.

Ablauf pro Re-Plan:
1. Beim HOLD: aus den fact-check-Flags der ORIGINAL-Entscheidung
   (structuralCheck→jetzt fact-check-core) die predicate-gated Objections nehmen (magnitude/
   direction/range) und via predicateFromFlag ein ObjectionPredicate authoren.
   → BRAUCHT: der VTA-Wrapper muss die vollen Flags durchreichen (claimedValue/actualValue),
     nicht auf {kind, evidenceLine} narrowen. = Wrapper-Erweiterung (Schritt 1 im Bau).
2. Beim RESOLVE: die REVIDIERTE Entscheidung durch fact-check-core measuren
   (measureRevisedValue aus dem SELBEN market-snapshot — Invariante A) → MeasuredValue.
3. checkRevision(predicate, measured) → boolean pro predicate-gated Objection.
4. Ergebnis in den DecisionRecord.replan schreiben (+ enforcementLevel-Markierung pro Objection).
   Fuzzy-Objections (inferential etc.) bleiben beim fresh-judgment (revisedVerification).

## Welche Repos wie berührt werden

- **fact-check-core:** evtl. measureRevisedValue/checkRevision als Export bereitstellen (sind im
  Sentinel-Repo — ggf. dorthin ODER in die Lib duplizieren/verschieben). ENTSCHEIDUNG NÖTIG:
  wohnt die predicate-Logik in fact-check-core (dann beide Konsumenten + kein Sentinel-Import
  im VTA) oder bleibt sie im Sentinel (dann muss der VTA sie importieren)? → EMPFEHLUNG:
  predicate-Logik nach fact-check-core ziehen (sie gehört zur fact-check-Familie, ist
  daten-neutral, und der VTA hat die Lib eh schon als dep). Sentinel re-exportiert sie dann.
- **verified-trading-agent:** (1) structural-check-Wrapper: volle Flags durchreichen. (2) main.ts
  replan-loop: das Gate einhängen. (3) DecisionRecord-Typ: replan-Feld um gate-Ergebnis erweitern.
- **thoughtproof-sentinel:** wenn predicate-Logik nach core zieht — Import umbiegen, sonst unberührt.
- **cb4a:** analog zum VTA-replan-loop, ABER Live-Geld → separater Schritt, eigener Steelman+Go.

## Reihenfolge (wenn gebaut — reversibel, VTA zuerst weil pausiert)

1. predicate-Logik (predicateFromFlag/satisfiesPredicate/measureRevisedValue/checkRevision) nach
   fact-check-core ziehen, Sentinel re-exportiert (no-op für Sentinel-main-Merge). Tests grün halten.
2. VTA structural-check-Wrapper: volle Flags durchreichen (neuer Rückgabetyp, verification.ts anpassen).
3. VTA main.ts: Gate im replan-loop einhängen, Ergebnis in DecisionRecord.
4. Test/Sample: falsche Zahl in Revision → Gate ignoriert sie (misst aus snapshot) → boolean.
   Das ist der "aktives Gate"-Beweis (vs. heute nur Mechanismus).
5. cb4a analog — separater Steelman + Raul-Go (Live-Geld).

## Offene Design-Entscheidung für Raul

Kern-Frage: WO wohnt die predicate-Logik? (a) nach fact-check-core ziehen [Empfehlung:
daten-neutral, beide Konsumenten, kein cross-repo-Import im VTA], oder (b) im Sentinel lassen
[dann VTA importiert Sentinel — neue Kopplung Sentinel↔VTA, die wir bei der shared-lib gerade
vermeiden wollten]. (a) ist konsistent mit der ganzen shared-lib-Logik.

## Risiko / ehrliche Grenzen

- Das ist eine ECHTE Verhaltensänderung im replan-loop (nicht nur additive Doku). Bei einer
  predicate-gated Objection entscheidet jetzt ein deterministischer boolean mit, nicht nur das
  Modell. Muss gegen echte replan-Cases getestet werden bevor es live geht (= Stufe 3 Kalibrierung,
  die 876 cb4a-Cases). Reihenfolge: Verdrahtung bauen + an Testdaten prüfen, DANN live.
- "aktives Gate" gilt erst wenn Schritt 1-4 durch UND an echten Cases kalibriert. Bis dahin bleibt
  die ehrliche Formulierung "Mechanismus verdrahtet, Kalibrierung ausstehend".
- VTA-Anbindung wird erst beim nächsten VTA-Start aktiv (mm-Login pending).
