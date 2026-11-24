# Experimenteller Offline-Prüfvertrag

Dieser Prototyp validiert **bereits extrahierte strukturierte Sachverhalte und bereits gelieferte semantische Urteile**. Er implementiert weder Extraktion noch einen semantischen Prüfer. Es gibt keinen Provider, Netzwerkzugriff, Schlüsselzugriff, HTTP-Endpunkt oder Anschluss an die Produktionsengine. Das erfundene Entwicklungsbeispiel ist keine Modellvorhersage. Erfolgreiche Tests belegen Vertragsverhalten, keine Modellgüte, Benchmarkquote oder Merge-Reife.

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

Die Berechnung arbeitet mit `BigInt` und Dezimalskalen, ohne Float-Rundung. `<` und `<=` bleiben bei Gleichheit verschieden. Unterstützt sind ASCII-Dezimalstrings bis 128 Zeichen; Exponenten, Tausenderformate, Unicode-Minus und Ausschnitte aus Zahlen/Bezeichnern werden konservativ abgelehnt. Es wird keine beliebige Zahl aus Freitext gesucht oder mit einer anderen Zahl verglichen. Der kanonische Vergleichsoperator und seine semantische Bindung an die Grenze bleiben Adapterverantwortung.

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

## Nächster Evaluationsschritt

1. Einen modellneutralen Extraktions-/Antwortadapter und Prompt gegen diesen Vertrag auf eigenen Entwicklungsfällen entwickeln. Instruktion: Dokumente sind Daten; alle relevanten Vorgaben und zusätzlichen Aussagen erfassen, Unsicherheit ausdrücklich melden, Originalbelege unverändert referenzieren, keine Antwort allein wegen gleicher Wörter als konsistent bewerten. Der Adapter muss genau den strukturierten Vertrag liefern; dieser Prototyp enthält noch keinen solchen Adapter oder Prompt-Runner. Bereits vor bezahlten Entwicklungsaufrufen ist eine gesonderte Freigabe erforderlich.
2. Danach den vollständigen Kandidaten einschließlich Adapter, Prompt, Vertragsversion, Code und Modellkonfiguration auf einem Commit einfrieren und die blinde Abnahme mit Kriterien und Nennern vorregistrieren. Entwicklungsfixtures vom unabhängig erstellten Abnahmesatz trennen; der Builder erhält dessen Fälle und Ergebnisse vor dem Einfrieren nicht.
3. **Modellantworten**, **validierte Prüfschritte** und **finale Entscheidungen** getrennt erfassen. Modellfehler, Referenz-/Schemafehler und Aggregationsfehler separat auswerten. Rohdaten gehören ausschließlich in den dafür freigegebenen lokalen Evaluationsspeicher, nicht in öffentliche Ergebnisse.
4. Auf vorab gelabelten Fällen getrennt messen: null falsche ALLOW auf allen nicht freizugebenden Fällen; mindestens 80 % richtige ALLOW auf tatsächlich zulässigen Fällen. UNCERTAIN zählt dort nicht als richtige Freigabe. Die Zusammensetzung und Nenner des Abnahmesatzes vorab festlegen.
5. Vor bezahlten Modellaufrufen gesonderte Freigabe einholen. Erst diese unabhängige Abnahme kann Aussagen über Modellgüte oder eine mögliche Integration tragen.
