# Flash Sales

[English](README.md) · **Deutsch** · [Português](README.pt-BR.md)

Ein Backend für Flash Sales: begrenzter Bestand, Hunderte Käufer klicken in
derselben Sekunde auf „Kaufen", und eine Regel darf nie brechen: Es wird nie
mehr verkauft, als vorhanden ist.

Das Repository ist zugleich ein Experiment mit Messungen. Jedes Feature wird
zweimal gebaut, einmal von einer KI-Delivery-Pipeline aus mehreren Agenten und
einmal direkt mit Claude Code. Verglichen werden Nacharbeit, Fehler und Kosten.

## Warum dieses Projekt

Flash Sales sind eine kleine Domäne mit harten Problemen: Race Conditions beim
Bestand, wiederholte Requests, die keine doppelten Bestellungen erzeugen
dürfen, Reservierungen, die ablaufen, und Events, die einen Absturz des Workers
überstehen müssen. Jedes Feature der Roadmap greift eines dieser Probleme auf
und bringt eine Invariante mit, die ein Black-Box-Test prüfen kann.

Das zweite Ziel ist, eine Frage mit Daten statt mit Meinungen zu beantworten:
Senkt eine KI-Pipeline mit Planner-, Coder-, Tester- und Reviewer-Agenten die
Nacharbeit wirklich im Vergleich zu einem einzelnen Agenten, und was kostet
das? Protokoll, Hypothesen und Entscheidungsregel wurden vor dem ersten Feature
festgehalten. Negative Ergebnisse werden ebenfalls veröffentlicht.

## Status

| ID | Feature | Invariante, die das Orakel prüft | Status |
|---|---|---|---|
| F01 | Verkauf mit Bestand + atomare Reservierung | N gleichzeitige Bestellungen bei Bestand E ergeben genau E Erfolge | fertig |
| F02 | `Idempotency-Key` bei Bestellungen | derselbe Key zweimal gesendet, auch gleichzeitig, ergibt 1 Bestellung und dieselbe Antwort | in Arbeit |
| F03 | Ablauf der Reservierung | eine unbezahlte Reservierung läuft nach der TTL ab, und der Bestand kommt zurück | geplant |
| F04 | Transactional Outbox + RabbitMQ | keine Bestellung bleibt ohne Event, auch wenn der Worker mittendrin ausfällt | geplant |
| F05 | Saga mit Kompensation | eine abgelehnte Zahlung storniert die Bestellung und gibt den Bestand zurück | geplant |
| F06 | Warteraum | nie mehr als N aktive Tokens; die Position in der Warteschlange sinkt nur | geplant |
| F07 | Retry + DLQ | vorübergehende Fehler lösen sich per Retry; dauerhafte landen in der DLQ; die Wiederverarbeitung funktioniert | geplant |

## Stack

- TypeScript 6 auf Node.js 24, NestJS 12 (ESM)
- PostgreSQL 17 über Prisma 7 (Driver Adapter `@prisma/adapter-pg`)
- Redis 7 (in Docker Compose bereitgestellt, noch nicht genutzt)
- Vitest 4 + Supertest für E2E-Tests gegen eine echte Datenbank
- oxlint (type-aware) und Prettier
- pnpm 11 Workspaces + Turborepo
- Docker Compose für die lokale Infrastruktur

## So funktioniert die atomare Reservierung (F01)

Der klassische Fehler heißt Lesen, Prüfen, Schreiben: Bestand lesen, prüfen, ob
er über null liegt, dann `stock - 1` schreiben. Zwei Requests lesen im selben
Moment `stock = 1`, beide bestehen die Prüfung, und eine Einheit wird zweimal
verkauft.

Hier ist die Reservierung ein einziges SQL-Statement
([`sales.service.ts`](apps/api/src/sales.service.ts)):

```sql
WITH reserved AS (
  UPDATE sales SET stock = stock - 1
  WHERE id = $saleId AND stock > 0
  RETURNING id
)
INSERT INTO orders (id, "saleId", "buyerId")
SELECT $orderId, id, $buyerId FROM reserved;
```

- Das `UPDATE` setzt eine Zeilensperre. Gleichzeitige Requests auf denselben
  Verkauf warten darauf, und sobald einer die Sperre bekommt, prüft Postgres
  `stock > 0` erneut gegen die neueste Version der Zeile. Der Bestand fällt nie
  unter null.
- Dekrement und Insert stehen im selben Statement. Sie werden also gemeinsam
  committet oder scheitern gemeinsam, ohne interaktive Transaktion und mit nur
  einem Roundtrip zur Datenbank.
- Wird keine Zeile eingefügt, unterscheidet der Service „Verkauf existiert
  nicht" (`404`) von „ausverkauft" (`409 SOLD_OUT`).

Warum nicht die üblichen Alternativen:

- `SELECT ... FOR UPDATE` in einer interaktiven Transaktion ist ebenfalls
  korrekt, hält die Sperre aber über mehrere Roundtrips.
- Ein Zähler in Redis ist schnell, aber dann liegt der Bestand in zwei
  Speichern, die auseinanderlaufen können.

### Tests

Die E2E-Suite läuft gegen das echte Postgres aus Docker Compose, ohne Mocks.
Unter anderem:

- 200 gleichzeitige Bestellungen bei Bestand 50: genau 50 × `201` mit
  unterschiedlichen Order-IDs, 150 × `409`, Endbestand 0 und 50 Zeilen in
  `orders`
- 100 gleichzeitige Bestellungen bei Bestand 1: genau ein Erfolg
- verschränkte gleichzeitige Bestellungen auf zwei Verkäufe: kein Bestand
  wandert vom einen zum anderen
- feindliche Eingaben: NUL-Bytes in Pfad und Body (sie führten früher zu einem
  `500`, weil Postgres `0x00` in Text ablehnt) und SQL-Injection in `buyerId`,
  die wörtlich gespeichert wird

## API

| Methode | Route | Body | Antworten |
|---|---|---|---|
| `POST` | `/sales` | `{ "name": string, "stock": integer ≥ 1 }` | `201 { id, name, stock }` · `400` |
| `GET` | `/sales/:id` | keiner | `200 { id, name, stock }` · `404` |
| `POST` | `/sales/:id/orders` | `{ "buyerId": string }` | `201 { orderId, status: "RESERVED" }` · `409 { error: "SOLD_OUT" }` · `404` · `400` |

## Lokal starten

Benötigt werden Node.js 24, pnpm 11 und Docker.

```bash
docker compose up -d                          # Postgres auf :55432, Redis auf :56379
pnpm install                                  # erzeugt auch den Prisma-Client
pnpm --filter api exec prisma migrate deploy  # legt die Tabellen an
pnpm --filter api start:dev                   # API auf http://localhost:3000
```

Eine `.env` ist nicht nötig: Ohne sie nutzt die App die Datenbank aus Docker
Compose. Mit `DATABASE_URL` lässt sich eine andere angeben.

```bash
curl -s -X POST localhost:3000/sales \
  -H 'content-type: application/json' -d '{"name":"Sneaker","stock":2}'
curl -s -X POST localhost:3000/sales/<id>/orders \
  -H 'content-type: application/json' -d '{"buyerId":"alice"}'
```

Prüfungen:

```bash
pnpm typecheck
pnpm lint
pnpm --filter api test:e2e   # braucht docker compose up
```

## Das Experiment: KI-Pipeline vs. Claude Code direkt

**Frage.** Wie viel Nacharbeit nach der Auslieferung verhindert eine
Multi-Agenten-Pipeline (Planner → Coder → Simplifier → Tester → Breaker → E2E →
Reviewer) im Vergleich zu Claude Code direkt, und wie viel mehr kostet sie?

**Hypothesen, vorab registriert.** H1: Mit der Pipeline sinkt die Nacharbeit um
mindestens 30 %. H2: Die Pipeline besteht bei der ersten Auslieferung mehr
Orakel-Tests. H3: Die Pipeline verbraucht 3- bis 5-mal so viele Tokens und so
viel Laufzeit, braucht aber weniger Minuten menschlicher Aufmerksamkeit.

**Design.**

- Gepaartes A/B pro Feature: Beide Arme starten vom selben Commit (Tag
  `F0X-base`), mit demselben Modell und derselben eingefrorenen
  Feature-Beschreibung.
- Verdecktes Orakel: Black-Box-Akzeptanztests über HTTP, geschrieben, bevor
  einer der Arme läuft, und außerhalb des Repos aufbewahrt, damit kein Agent sie
  sieht.
- Blindes Review: `scripts/rework.sh blind F0X` mischt die beiden Diffs zu A und
  B, und die Fehler werden notiert, bevor der Schlüssel geöffnet wird.
- Nacharbeit sind hinzugefügte plus entfernte Zeilen zwischen den Tags `done`
  und `accepted`, berechnet von `pnpm rework`, nie von Hand.
- Entscheidungsregel, vor F02 festgelegt: Die Pipeline gilt nur dann als echter
  Gewinn, wenn sie von F02 bis F07 in mindestens der Hälfte der Features mit
  weniger Fehlern ausliefert als der direkte Arm und dabei höchstens das
  2,5-Fache der Tokens verbraucht.

### Ergebnisse der F01

| | direct | pipeline |
|---|---:|---:|
| Orakel bei der ersten Auslieferung | 14/14 | 14/14 |
| Fehler im blinden Review (hoch/mittel/niedrig) | 1/0/0 | 0/0/3 |
| Nacharbeit bis zur Abnahme (± Zeilen) | 18 | 0 |
| Korrekturrunden | 1 | 0 |
| ausgelieferte Zeilen: Produktion / Tests | 132 / 125 | 127 / 486 |
| Tokens bis zur Abnahme | 154.690 | 951.306 |
| Laufzeit bis zur Abnahme | 3,8 min | 36,1 min |

Was sich bisher sagen lässt:

- Die adversariale Stufe der Pipeline (der Breaker) fand den einzigen echten
  Bug: Ein NUL-Byte in der Eingabe wurde zu einem `500`. Der direkte Arm hat
  diesen Bug ausgeliefert, und auch das Orakel hat ihn übersehen.
- H1 gilt auf dem Papier (18 Zeilen gegen 0), H2 nicht (Gleichstand bei 14/14),
  und H3 hat die Kosten unterschätzt: 6,2-mal so viele Tokens und 9,4-mal so
  viel Laufzeit. Die Hälfte davon floss in Korrekturschleifen, und eine davon
  reparierte nur eine instabile Testsuite, die die Pipeline selbst erzeugt
  hatte.
- n = 1. Verallgemeinern lässt sich noch nichts.

Aus diesen Zahlen entstand die **Pipeline v2**: ein Builder, der TDD in einem
einzigen Kontext macht, und ein unabhängiger Verifier, der die laufende API
angreift. Der Planner und die übrigen Stufen kommen nur hinzu, wenn ihr
Auslöser greift. Neue Hypothese H4: Die v2 verbraucht höchstens 40 % der Tokens
der v1 bei gleicher Qualität.

### Grenzen der Validität

- **Kleine Stichprobe (n = 7 Features).** Es ist eine Fallstudie: Die
  Ergebnisse werden Feature für Feature gezeigt, ohne p-Werte.
- **Dieselbe Person schreibt das Orakel und reviewt.** Abgemildert dadurch,
  dass das Orakel zuerst geschrieben und blind reviewt wird. In der F01 hat
  Claude das Orakel geschrieben, und es enthielt keine feindlichen Eingaben; ab
  der F02 schon.
- **Die Verblindung ist unvollkommen.** Der Diff der Pipeline enthält meist mehr
  Tests und ist daran erkennbar.
- **Lerneffekte zwischen Features.** Die Paarung auf demselben Feature gleicht
  sie aus, und die Reihenfolge der Arme wechselt.
- **Die Kosten der F01 sind unterschätzt.** Die menschlichen Minuten wurden
  nicht gemessen, und die Tokens des Pipeline-Orchestrators wurden nicht
  mitgezählt.

Vollständige Dokumentation, auf Portugiesisch:
[Protokoll](docs/experiment/PROTOCOL.md),
[Ergebnisse](docs/experiment/RESULTS.md),
[Pipeline v2](docs/experiment/PIPELINE-V2.md) und
[Rohdaten](docs/experiment/ledger.csv).

## Aufbau des Repositorys

```
apps/api/              NestJS-API
  src/sales.*.ts       Controller und Service der F01
  prisma/              Schema und Migrationen
  test/                E2E-Tests gegen das echte Postgres
docs/experiment/       Protokoll, Feature-Specs, Ergebnisse, Ledger und Run-Belege
scripts/rework.sh      Nacharbeitsmetriken und Export für das blinde Review
docker-compose.yml     Postgres 17 + Redis 7 für die lokale Entwicklung
```

## Konventionen

- **Git Flow.** `main` enthält die Releases, `develop` integriert, und jedes
  Feature lebt in einem `feature/*`-Branch, der mit `--no-ff` gemergt wird.
- **Conventional Commits.** Der Commit-Body erklärt das Warum, nicht nur das
  Was.
- **`ponytail:`-Kommentare** markieren bewusste Vereinfachungen und sagen, wann
  sie ausgebaut werden sollten, zum Beispiel die Inline-Validierung, bis die
  Request-Bodies wachsen.
