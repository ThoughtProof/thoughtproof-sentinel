# Experimenteller Offline-Prüfvertrag

Dieser Prototyp validiert strukturierte Sachverhalte und semantische Urteile. Der Evaluator ruft kein Modell auf. Ein Offline-Adapter kann eine handgeschriebene oder später gelieferte JSON-Antwort in den Vertrag übersetzen; diese Arbeitskopie enthält keinen Provideraufruf, keinen Schlüsselzugriff, keinen HTTP-Endpunkt und keinen Anschluss an die Produktionsengine. Erfundene Entwicklungsfälle sind keine Modellvorhersagen. Erfolgreiche Tests belegen Vertrags- und Parserverhalten, keine Modellgüte, Benchmarkquote oder Merge-Reife. Die Wirkung des Prompts ist ungemessen, bis ein gesondert freigegebener bezahlter Lauf stattfindet.

Der genaue JSON-/TypeScript-Vertrag steht in [contract.ts](./contract.ts). Unbekannte Felder sind unzulässig. Dokumente bleiben unverändert; Positionen sind nullbasierte **UTF-16-Code-Units** mit exklusivem Ende. Belege müssen Dokumentkennung, Position und Originaltext exakt treffen und dürfen nicht leer oder ausschließlich Whitespace sein. Der eigentliche Zitatvergleich trimmt und normalisiert weder Unicode noch Zeilenenden.

## Kurzer Prüfvertrag

| Prüfung | Pflicht und Bedeutung |
| --- | --- |
| `decision_basis` | Immer: tatsächlicher Handelsentscheid mit ausreichender, unabhängig belegter Entscheidungsgrundlage. Diese kann aus These und Evidenz kommen; eine separate Begründungszeile oder bestimmte Überschrift ist keine Pflicht. |
| `order_strategy_consistency` | Immer: die konkrete Order passt inhaltlich zur belegten Strategie/Entscheidungsabsicht. Bedeutungsäquivalenz, Instrumentidentität und Ordertyp beurteilt der semantische Adapter, keine Wortgleichheit. |
| `mandate_compliance` | Alle explizit extrahierten Mandatsvorgaben. Ohne solche Vorgaben ist nach vollständiger Anwendbarkeitsprüfung N/A möglich. |
| `additional_claims` | Zusätzliche Behauptungen unterscheiden: belegte Tatsache, gestützte Schlussfolgerung, Rechnung, neue unbelegte Tatsache. Ohne zusätzliche Behauptungen ist nach vollständiger Prüfung N/A möglich. |
| `numeric_limits` | Alle expliziten Grenzen mit eindeutig zugeordneten Zahlen. Ohne Grenzen ist nach vollständiger Prüfung N/A möglich; es werden keine Grenzen erfunden. |

Jede Prüfung liefert `fulfilled`, `contradicted`, `not_verifiable` oder `not_applicable`. Positive Pflichtbefunde benötigen Originalbelege aus der Order **und** mindestens einem unabhängigen `source`-Dokument. Eine zusätzliche Tatsachenbehauptung oder Schlussfolgerung darf sich nicht allein selbst zitieren. Strategie-/Mandatsbefunde müssen die vollständige passende Vorgabenliste und deren Belege berücksichtigen. Negative Tatsachenbefunde benötigen ebenfalls echte Referenzen. Bei einer als neu und unbelegt klassifizierten Tatsache wird die tatsächlich behauptete Aussage zitiert; ihre fehlende Stützung bleibt ein semantischer Befund über den vollständig betrachteten Kontext.

**N/A ist eine explizite Vertrauensentscheidung:** Der Aufrufer muss die Adapterkennung lokal freigeben. Der Adapter bestätigt Version, Vollständigkeit und SHA-256-Abdeckung aller unveränderten UTF-8-Dokumente; jede Anwendbarkeitsprüfung nennt zusätzlich alle Dokumente und den Grund `none_in_complete_scope`. N/A ist nur für die drei optionalen Prüfungen und bei leerer entsprechender Vorgaben-/Behauptungs-/Grenzenliste möglich. Fehlende Felder bedeuten niemals N/A. Ein Zitat einer Abwesenheit ist nicht erforderlich.

**Trustgrenze:** Kennung, Vollständigkeitsbehauptung und Hash sind keine Signatur und kein Beweis semantischer Richtigkeit. Der vertrauenswürdige Adapter muss alle relevanten Inhalte erfasst, Identitäten/Einheiten/Referenzgrößen/Operatoren korrekt normalisiert und Schlussfolgerungen wirklich geprüft haben. Die lokale Freigabeliste darf nicht aus der Modellantwort übernommen werden. Auch ein exakt passendes Zitat beweist weder Entailment noch die Wahrheit oder Herkunft des Quelldokuments. Eine falsche, aber formal gültige Adapteraussage kann daher weiterhin zu einer falschen Freigabe führen; das wird erst unabhängig evaluiert.

## Zahlen und Aggregation

Zahlen werden nur aus benannten `quantities` und `limits` verwendet. Subjekt, Messgröße, Einheit und Referenz müssen exakt dieselben **vom Adapter normalisierten Identitäten** besitzen. Jede Zahl hat eine eigene Referenz auf ein vollständiges Dezimaltoken; dessen Wert muss zum angegebenen Dezimalstring passen und innerhalb des referenzierten Bindungskontexts stehen. Grenze und Messwert dürfen keine überlappenden Zahlentoken zitieren. Fehlende Zuordnung, andere Maße/Einheiten oder nicht unterstützte Schreibweisen ergeben `not_verifiable`.

Die Berechnung arbeitet mit `BigInt` und Dezimalskalen, ohne Float-Rundung. `<` und `<=` bleiben bei Gleichheit verschieden. Der kanonische `value` ist ein ASCII-Dezimalstring bis 128 Zeichen. Das Originalzitat darf englische oder deutsche Interpunktion tragen: `1.234,56` ist eindeutig 1234.56, `1,234.56` ist eindeutig 1234.56, `1.234.567` ist eindeutig 1234567. Ein Token mit beiden Lesarten, insbesondere `1.234` und `1,234`, bleibt unbestimmt; es wird keine Lesart gewählt. Exponenten, Unicode-Minus, Apostroph-Tausender und Leerraum-Gruppen werden abgelehnt. Ein Punkt direkt nach der Zahl ist erlaubt, wenn er den Satz beendet (`unter 70.`, `below 70.`), nicht wenn eine weitere Ziffer folgt (`70.5`, `170`). Ein zitierter Präfix eines längeren Tokens ist kein Treffer.

Prozentgrenzen brauchen eine eindeutige Referenzgröße (Prozent wovon). Fehlt sie, ist sie nur das Wort Prozent, oder konkurrieren zwei Größen (`of equity or of cash`), bleibt der Vergleich unbestimmt. Eine Zahlgrenze kann zugleich ein Mandat sein. Die Abschnittsüberschrift allein entscheidet weder Grenze noch Mandat; ein reines `Mandate:` oder `Limits:` ist kein Beleg. Steht in einem zitierten Mandat eine Vergleichsformulierung mit einer Zahl und fehlt die dazu passende Grenze, gibt es kein ALLOW.

Belegpositionen werden im Code durch exakte UTF-16-Suche abgeleitet. Kommt das Zitat nicht oder mehr als einmal vor, auch überlappend, ist der Beleg ungültig. Vom Modell mitgelieferte Offsets werden nicht verwendet.

Für `calculation` unterstützt dieser kleine Prototyp nur exakte Addition/Subtraktion gleich gebundener Größen mit zitierten Operanden und Ergebnis. Eine korrekte Rechnung kann neue berechnete Information erlauben; sie wird nicht automatisch als erfundene Tatsache behandelt. Falsche, vollständig gebundene Arithmetik widerspricht dem Vertrag. Korrekte Arithmetik mit widersprechendem semantischem Urteil ist `not_verifiable`. Andere Rechenarten und Einheitenumrechnung sind noch nicht implementiert.

Ein unabhängig gültiger, belegter Widerspruch ergibt **BLOCK**, unabhängig von Reihenfolge oder anderen unsicheren/fehlenden Schritten. Doppelte oder ungültige Zeilen werden nicht willkürlich ausgewählt; die betroffene Prüfung bleibt unklar. Ohne belegten Widerspruch ergeben unvollständige/ungültige Eingaben **UNCERTAIN**. Beschädigte Dokument-/Adapterintegrität macht den gesamten Vertrag nicht prüfbar. **ALLOW** erfordert einen vollständigen gültigen Vertrag und belegte Erfüllung sämtlicher anwendbaren Prüfungen.

## Offline ausführen

Voraussetzung: Node mit TypeScript-Stripping (z. B. Node 22.18+; hier mit Node 26.5.0 geprüft) und die bereits installierten Repository-Entwicklungsabhängigkeiten. Es gibt keine zusätzliche Dependency. Aus dem Repository-Verzeichnis:

```sh
node --experimental-strip-types experiments/trade-contract/offline.ts
./node_modules/.bin/vitest run experiments/trade-contract/contract.test.ts
./node_modules/.bin/tsc -p experiments/trade-contract/tsconfig.json
```

Ohne Argumente läuft ausschließlich [development-fixture.ts](./development-fixture.ts), ein handgeschriebener Entwicklungsfall mit explizit lokal freigegebenem Fixture-Adapter. Eine eigene bereits strukturierte lokale JSON-Datei lässt sich so prüfen:

```sh
node --experimental-strip-types experiments/trade-contract/offline.ts --input local-contract.json --trust-adapter locally-approved-adapter
```

Die Kennung muss zur bewusst freigegebenen Adapterimplementierung gehören; sie ist kein Modellparameter. Ohne `--trust-adapter` kann eine externe Datei nicht freigegeben werden. Exit-Codes: ALLOW `0`, BLOCK `2`, UNCERTAIN/ungültige CLI-Eingabe `3`. Standardausgabe enthält nur Version, Entscheidung und feste Prüfkennungen/Status. Rohmodelltext, Zitate, Dokumentkennungen und Freitext fehlen. `--diagnostics` ergänzt ausschließlich lokale Fehlercodes und Schemapfade, ebenfalls ohne Rohtext. Es entsteht keine neue HTTP-Oberfläche.

## Offline-Adapter

[prompt.ts](./prompt.ts) ist die eingefrorene Instruktion. [model-config.ts](./model-config.ts) pinnt xAI, primär `grok-4.7`, einmalig sekundär `grok-4.3`, Temperatur 0, Seed 42 (von der Chat-Completions-Referenz dokumentiert, Determinismus nicht garantiert), `max_completion_tokens` 4096, `response_format` `json_schema` mit `strict: true`, Timeout 45_000 ms, keine Wiederholung, keine Block-Bestätigung. Modellkennungen und Preise stehen auf https://docs.x.ai/docs/models (abgerufen 2026-11-24). Der Endpunkt ist `https://api.x.ai/v1/chat/completions`. [adapter.ts](./adapter.ts) parst JSON, verwirft Positionsangaben, leitet Spannen ab und übergibt den bestehenden Vertrag. `buildAdapterMessages` liefert genau zwei Nachrichten, zuerst `system` mit dem Prompt, dann `user` mit dem JSON-Array der Dokumente. `buildAdapterRequest` baut daraus den Grok-Körper und übernimmt jedes body-Feld der Modellkonfiguration, einschließlich `response_format` als `json_schema`. Timeout, Retries, Endpunkt und die Block-only-Politik stehen nicht im JSON-Körper. Parsefehler, Schemaverletzungen, fehlende Prüfungen, Timeouts, HTTP- und Transportfehler ergeben UNCERTAIN, nie ALLOW. Eine schema-gültige Primärentscheidung, auch UNCERTAIN, wird nicht an das zweite Modell weitergereicht. Fällt die Primärantwort durch, darf `grok-4.3` nur BLOCK veröffentlichen. ALLOW, CONDITIONAL_ALLOW, HOLD und jedes andere Nicht-BLOCK-Ergebnis werden UNCERTAIN. Scheitern beide Modelle, ist das Ergebnis UNCERTAIN. Ein bloßes „no mandate found“ reicht nicht. Unvollständige oder unsichere Erkennung verhindert die Freigabe.

**Offenes Abnahmerisiko:** Meldet das Modell die Mandatssuche ausdrücklich als vollständig und findet keines, kann der Vertrag weiterhin ALLOW ergeben. Eine falsche, formal vollständige Abwesenheitsaussage ist damit nicht ausgeschlossen. Genau dieses Risiko bleibt Gegenstand der späteren unabhängigen Abnahme und gilt hier nicht als gelöst. Es wird keine Trefferquote behauptet. Zielwerte für diesen späteren Lauf, nicht als hier gemessenes Ergebnis: null falsche ALLOW und mindestens 80 % richtige ALLOW.

Der Freeze steht in [CANDIDATE.manifest.json](./CANDIDATE.manifest.json): SHA-256 der Prompt-Vorlage, SHA-256 der kanonischen Modellkonfiguration und SHA-256 der Quelldateien. `vercel.json` lässt Git-Deployments für `cursor/trade-contract-offline-20261124` aus; das bleibt bis vor einem späteren Merge stehen.

## Nächster Evaluationsschritt

1. Der Kandidat aus Prompt, Adapter, Vertrag und Modellkonfiguration ist auf einem Commit eingefroren. Entwicklungsfälle bleiben vom unabhängig erstellten Abnahmesatz getrennt. Der Builder hat dessen Fälle und Ergebnisse nicht.
2. **Modellantworten**, **validierte Prüfschritte** und **finale Entscheidungen** getrennt erfassen. Modellfehler, Referenz-/Schemafehler und Aggregationsfehler separat auswerten. Rohdaten gehören ausschließlich in den dafür freigegebenen lokalen Evaluationsspeicher, nicht in öffentliche Ergebnisse.
3. Auf vorab gelabelten Fällen getrennt messen: null falsche ALLOW auf allen nicht freizugebenden Fällen; mindestens 80 % richtige ALLOW auf tatsächlich zulässigen Fällen. UNCERTAIN zählt dort nicht als richtige Freigabe. Die falsche vollständige Abwesenheitsmeldung ist Teil dieser Abnahme. Die Zusammensetzung und Nenner des Abnahmesatzes vorab festlegen.
4. Vor bezahlten Modellaufrufen gesonderte Freigabe einholen, mit einer festen Kostenobergrenze. Erst diese unabhängige Abnahme kann Aussagen über Modellgüte oder eine mögliche Integration tragen.
