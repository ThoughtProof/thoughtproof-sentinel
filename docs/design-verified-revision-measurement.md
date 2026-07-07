# Design: Verified-Revision-Measurement Pipeline

*Status: DESIGN (kein Code). Autor: Hermes für Raul. Kontext: objection-binding follow-on,
mit Federico (invinoveritas) entwickelt. 2026-07-07.*

## Zweck

Die "given an independently-measured revision value"-Bedingung des predicate-gates von
DOKUMENTIERT (aktueller Stand: `checkRevision` existiert, ist aber nicht verdrahtet und
akzeptiert ein potenziell hand-gebautes `MeasuredValue`) zu ECHT ERZWUNGEN machen:
der deterministische Fact-Checker — nicht der Agent — produziert `revisedValue` end-to-end.

Federicos Framing (die Latte): *"A boolean gate is only as trustworthy as its weakest input.
If revisedValue is self-reported, the whole predicate collapses back to exactly the failure
mode we just fixed — just moved one level down."* Und: *"this one is about trusting a
measurement pipeline, not designing a comparison"* — bewusst nicht rushen.

## Faktenlage (verifiziert im Code, 07.07.)

1. **Der Snapshot ist schon da, agent-unabhängig.** `main.ts:186` verifiziert die revidierte
   Entscheidung gegen DENSELBEN `market`-Snapshot wie das Original (`main.ts:153`). Kein
   Marktdaten-Drift zwischen Hold und Resolve — beide teilen den Snapshot. Der Snapshot kommt
   aus der Datenquelle, NICHT aus Agent-Text.
2. **Die Werte werden intern berechnet, aber nie strukturiert herausgereicht.**
   `verification.ts:258` ruft `structuralCheck(decision, market)` auf und nutzt nur
   `f.evidenceLine` (Prosa, Zeile 268). ABER: die zwei Fact-Checker unterscheiden sich —
   - **cb4a** (`fact-check.ts:45-53`): `VerifiedFactFlag` HAT `{kind, claimText, claimedValue,
     actualValue, evidenceLine}` → hier werden strukturierte Werte erzeugt und dann zu Prosa
     verflacht = echter round-trip (Struktur da → weggeworfen).
   - **VTA** (`structural-check.ts:25-28`): `VerifiedFactFlag` hat NUR `{kind, evidenceLine}`.
     Die Werte (trendPct/rangePos) werden intern berechnet (Zeile 98-102), aber NIE in die
     Rückgabe strukturiert — sie landen direkt in der Prosa. Kein round-trip, sondern
     "internal calculation never surfaced": die Struktur existiert im VTA-Pfad gar nicht erst.
   Konsequenz fürs Design: Schritt 1 (VTA-flag an cb4a angleichen) ist NICHT optional-nice,
   sondern VORBEDINGUNG — im VTA gibt es aktuell keinen strukturierten Wert zum Weiterreichen.
3. **structuralCheck zieht actualValue aus dem Snapshot** (`structural-check.ts:88-91`):
   change7dPct, priceChangePct24h, range aus price/low24h/high24h. NIE aus Agent-Text
   (nur der claimedValue wird per Regex aus dem Text extrahiert).

## Die eigentliche Schwierigkeit (Federicos "different kind of hard")

Nicht der Vergleich (der ist gelöst: satisfiesPredicate). Sondern: **kann der Wert, den das
Gate prüft, NICHT vom Agenten beeinflusst worden sein?** Drei Ebenen, an denen Vertrauen
brechen kann:

- **(A) Messquelle:** actualValue kommt aus `market` (Snapshot). Vertrauenswürdig NUR wenn der
  Snapshot selbst nicht agent-kontrolliert ist. HEUTE: Snapshot kommt aus der Exchange-
  Datenquelle vor dem Agenten-Call → OK. MUSS im Design als Invariante festgehalten werden:
  der Snapshot wird VOR dem Agenten-Reasoning eingefroren und ist read-only.
- **(B) Extraktion des claimedValue:** per Regex aus Agent-Text. Der Agent KANN durch geschickte
  Formulierung steuern, was extrahiert wird (oder ob überhaupt). ABER: das betrifft nur die
  Objection-GENERIERUNG (was wird geflaggt), nicht die Messung des actualValue. Ein Agent, der
  seine Zahl versteckt, umgeht die Objection ganz — das ist ein separates Problem (Objection-
  Coverage), nicht die Mess-Pipeline. Ehrlich benennen, nicht vermischen.
- **(C) revisedValue-Messung:** MUSS `structuralCheck(revisedDecision, sameSnapshot).flags`
  sein, strukturiert weitergereicht — NICHT `evidenceLine`-Prosa, NICHT Agent-behauptet.
  Das ist der eine Punkt, den diese Pipeline schließt.

## Die Trust-Boundary — der Kern

Aktuelles `checkRevision(predicate, measured: MeasuredValue)` hat die Lücke: der Aufrufer
konstruiert `measured` und KÖNNTE es fälschen (well-formed forgery, Steelman-Fund). Fix:
**die Messung muss INNERHALB der Gate-Trust-Boundary passieren, nicht als übergebenes Objekt.**

Zwei Design-Optionen:

- **Option 1 — Gate misst selbst.** Signatur wird
  `checkRevision(predicate, revisedDecision, snapshot)`. Das Gate ruft intern
  `structuralCheck` → kein hand-baubares MeasuredValue mehr, weil der Aufrufer nur die
  (agent-unabhängigen) Rohdaten liefert. Der Aufrufer kann `snapshot` nicht fälschen ohne
  die Datenquelle zu kompromittieren (Invariante A). SAUBERSTE Grenze.
- **Option 2 — MeasuredValue nur via Factory + Brand.** measureRevisedValue bleibt einzige
  Quelle, MeasuredValue bekommt ein nicht-konstruierbares Brand (private Symbol / Modul-
  scoped). Verhindert hand-bauen zur Compile- UND Laufzeit im selben Package. Schwächer als
  Option 1, weil Cross-Package-Aufrufer das Brand umgehen könnten.

**Empfehlung: Option 1.** Die Boundary ist dann "wer liefert den Snapshot", und der ist per
Invariante A bereits agent-unabhängig. Das verschiebt das Vertrauen auf die EINE Stelle, die
ohnehin vertrauenswürdig sein muss (die Marktdatenquelle) — statt auf ein konstruierbares Objekt.

**Steelman-Vorbehalt gegen Option 1 (nicht wegdiskutieren):** Option 1 verkleinert die
Trust-Boundary nicht kostenlos — es verschiebt sie in ein Sentinel↔VTA-COUPLING. Das Gate
(Sentinel-seitig gedacht) bräuchte dann Zugriff auf `structuralCheck` + Kenntnis der
MarketSnapshot-Struktur (VTA-Interna). Ehrliche Bewertung: die Boundary wird *konzeptuell*
sauberer (Vertrauen auf Datenquelle statt konstruierbares Objekt), aber die *Kopplung* steigt.
Auflösung: die Messung gehört auf die VTA-Seite (structuralCheck lebt dort), das Gate bekommt
nur das fertige, VTA-gemessene strukturierte Flag. D.h. NICHT "Sentinel importiert VTA-Logik",
sondern "VTA misst und übergibt ein getyptes Ergebnis an das Gate". Das hält die Kopplung an
der bestehenden Grenze (VTA ruft Sentinel-Verify eh schon auf) statt eine neue zu schaffen.

## Was die Pipeline NICHT löst (ehrliche Grenzen)

- Objection-Coverage (B): ein Agent, der seine Zahl gar nicht nennt, wird nicht geflaggt.
  Separates Problem.
- Snapshot-Integrität (A): wenn die Marktdatenquelle selbst kompromittiert/agent-beeinflusst
  ist, bricht alles. Außerhalb des Scopes dieser Pipeline — muss als Annahme deklariert werden.
- **Präzisierung (Steelman): "agent-unabhängig" ist zu stark.** Der Snapshot-INHALT kommt aus
  der Datenquelle, nicht aus Agent-Text — das stimmt. ABER der Agent kann den Wert INDIREKT
  beeinflussen: (i) welches Asset (Volatilitätsprofil), (ii) Timing des Calls (welche Candles im
  Fenster), (iii) über mehrere Zyklen auf ein günstiges Fenster warten. Ehrliche Formulierung:
  *"der actualValue wird aus der Datenquelle GEMESSEN, nicht vom Agenten BEHAUPTET"* — das ist
  wahr und das ist der Gewinn. NICHT *"agent-unabhängig"* — denn Asset/Timing-Wahl bleibt beim
  Agenten. Die Pipeline schließt die Behauptungs-Lücke, nicht die Timing-Lücke.
- **Verzahnung (Steelman): Coverage + Timing sind Teile EINES Gaming-Problems.** Ein Agent, der
  weiß dass nur genannte Zahlen geflaggt werden, weicht auf Timing/Asset-Wahl aus. Die Trennung
  in "separate Probleme" ist Scope-Management, keine natürliche Grenze — ehrlich so benennen,
  nicht als saubere Separierung verkaufen. Die numeric-predicate-Pipeline ist EIN Baustein gegen
  Behauptungs-Gaming, nicht die Lösung des Adversarial-Agent-Problems.
- Nur die 3 numeric-Klassen. Fuzzy-Objections bleiben fresh-judgment.

## Integrationsschritte (wenn gebaut — NICHT jetzt, mm-Session tot + Federico rät zu Zeit)

1. `structuralCheck` so erweitern/nutzen, dass es die strukturierten flags zurückgibt (nicht
   nur evidenceLine) — die VTA-Version wirft claimedValue/actualValue aktuell weg
   (`structural-check.ts:25-28` VerifiedFactFlag hat nur kind+evidenceLine; cb4a-Version hat
   die vollen Werte). Erste Arbeit: VTA-flag-Struktur an cb4a angleichen.
2. `checkRevision` auf Option-1-Signatur umbauen (misst selbst aus snapshot).
3. Im replan-loop (`main.ts` nach Zeile 186): für jede predicate-gated Objection des Holds
   `checkRevision(predicate, revised.decision, market)` aufrufen, Ergebnis in die Chain schreiben.
4. Erst DANN ein Sample anchorn, wo revisedValue nachweislich gemessen (nicht gesetzt) ist.

## Verifikations-Kriterium (wann ist es "echt erzwungen")

Ein Test/Sample, wo: der Agent eine revidierte These mit einer FALSCHEN Zahl liefert, die
Pipeline sie IGNORIERT (misst aus Snapshot), und das Gate auf dem GEMESSENEN Wert entscheidet
— beweisbar, dass die Agent-Zahl nie das Gate erreicht hat. Das ist der Unterschied zu heute.
