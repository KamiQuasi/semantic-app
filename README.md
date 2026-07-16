# RDF Profile Platform

A proof-of-concept demonstrating how RDF and linked data principles can power a
modern web application — from data storage through server-side rendering to
real-time collaboration — without sacrificing developer ergonomics.

## What This Is

A multi-profile directory app where person data lives as RDF (Turtle files
backed by a WASM triplestore), UI labels are themselves RDF, SHACL shapes
validate data at the graph level, and live edits propagate in real time across
browser tabs and Deno Deploy isolates.

The goal is to validate that an RDF-native data layer can integrate cleanly with
standard web platform primitives: Web Components, declarative shadow DOM,
server-sent events, and `BroadcastChannel`.

## Architecture

### RDF as the Data Layer

All person data starts as `.ttl` (Turtle) files loaded into a single in-memory
[sparq](https://github.com/jeswr/sparq) WASM triplestore at startup. A typed
`ProfilePerson` class wraps the dataset with getter/setter properties
(`name`, `jobTitle`, `knowsLanguage` as a `Set<string>`, `hasSkill` as an RDF
list, `address` as a nested `PostalAddress` node) that read and write directly
to the triplestore through
[@rdfjs/wrapper](https://github.com/rdfjs-base/wrapper).

Cross-resource links work naturally: each person's `schema:worksFor` points to
an organization IRI defined in a separate file under `rdf/orgs/`, and the
template resolver follows the link to pull in org name, URL, and description —
no joins, no denormalization.

UI labels are also RDF. `rdf/ui.ttl` contains `rdfs:label` triples in three
languages (en, fr, es) for every field name and UI string. The server resolves
`[typeof]` elements against this label graph at render time, and a client-side
locale switcher toggles `xml:lang` visibility across shadow roots.

Profile *content* — not just chrome — is multilingual too. `jobTitle` and
`description` use RDF's real mechanism for a language fallback: one **untagged**
literal (plain `xsd:string`, no `@lang`) as the default value, alongside any
number of **language-tagged** (`rdf:langString`) translations —
`schema:jobTitle "Senior Software Engineer", "Ingénieure logicielle senior"@fr, "..."@es`.
This mirrors the same multi-element-same-property convention as the UI labels
(multiple elements sharing one RDFa property, differentiated by language), but
the fallback behavior is opt-in per element rather than a hardcoded rule:
elements tagged `xml:lang` (the read-only profile view) resolve missing
translations to the untagged default; elements tagged `data-lang` (the editor)
resolve the exact value only, so a translator can always tell whether a
language has genuinely been translated. The editor presents each multilingual
field as a small EN/FR/ES tab strip rather than showing (or hiding) three
stacked inputs — switching tabs shows exactly one language's field at a time
without touching the global locale switcher.

Organizations are a second managed resource type, one Turtle file per org
under `rdf/orgs/`, with the same session/SSE/KV architecture as profiles: a
full `/orgs` directory (list, add, edit, delete), live-updating the same way
`/people` does. A person's `schema:worksFor` link is set via a native
`<datalist>` autocomplete on the profile editor, backed by the live org list.

### SHACL Validation

`rdf/shapes/person.ttl` defines a SHACL `NodeShape` targeting `schema:Person`.
The sparq WASM engine runs SHACL validation natively via
`store.validate(data, shapes, 'turtle')` — no external validator needed.
Validation results map to per-property error arrays that the template resolver
injects as `aria-invalid` attributes and error messages. A `/api/validate/:id`
endpoint also exposes results as JSON.

### Six-Phase Server-Side Rendering

Templates use `<template shadowrootmode="open">` for declarative shadow DOM —
the browser hydrates shadow roots without waiting for JavaScript. The server
parses each template with [deno-dom](https://github.com/nicolo-ribaudo/deno-dom)
and runs a six-phase resolver pipeline inside each shadow root:

| Phase | What it does |
|---|---|
| **resolveTemplates** | Stamps `<template>` elements for array/set values (skills, languages) |
| **resolveLabels** | Fills `[typeof]` elements with multilingual label `<span>`s from the RDF label graph |
| **resolveState** | Binds scalar state to `[property]` elements, handling tag-specific semantics (A/href, IMG/src, INPUT/value) |
| **resolveTransforms** | Applies display transforms (`data-transform="capitalize"`) while preserving raw values in `content` |
| **resolveConditionals** | Shows/hides elements via `[data-if]` conditions |
| **resolveConditionalAttrs** | Sets/removes boolean attributes via `[data-attr-*]` conditions |

The result is a fully-rendered HTML document that works before any JavaScript
loads, then hydrates into live-updating Web Components.

### Real-Time Collaboration

Each profile gets a server-side session: a
[cpx-store](https://github.com/chapeaux/cpx-store) `CPXStoreCore` instance
paired with a `ServerSSETransport` that manages SSE client connections.

```
Browser                          Server                         Other Isolates
  |                                |                                |
  |-- POST /api/profile/:id ----->|                                |
  |   (state operation)           |-- SSE broadcast to clients     |
  |                               |-- onChange:                     |
  |                               |     update RDF dataset          |
  |                               |     serialize to Turtle         |
  |                               |     persist to Deno KV          |
  |                               |     BroadcastChannel ---------> |
  |                               |                                |-- reload RDF
  |<--- SSE event ---------------|                                |-- SSE to its clients
```

The collab plugin handles operation deduplication and echo prevention. An
`externalUpdate` flag on each session prevents BroadcastChannel-received
changes from being re-broadcast.

When a profile edit touches summary fields (`name`, `jobTitle`, `image`,
`isActive`), the server cascades the update to a separate people-list store,
so the `/people` directory view updates in real time too.

### Deno Deploy Compatibility

The app runs on Deno Deploy with no filesystem dependencies at runtime:

- **Persistence**: Profile edits are serialized to Turtle and stored in
  **Deno KV** (`["profiles", id]` keys). On cold start, bundled `.ttl` files
  load first, then KV entries overlay any persisted edits.
- **Cross-isolate sync**: **BroadcastChannel** replaces the filesystem watcher.
  Each message carries the full serialized Turtle, avoiding KV read races on
  the receiving isolate.
- **WASM**: The sparq triplestore is vendored at `vendor/sparq/` with the
  `.wasm` binary co-located for `fetch()`-based loading.

## Project Structure

```
server.ts                   Main server: routing, sessions, SSE, BroadcastChannel
server/
  rdf.ts                    RDF layer: ProfilePerson, dataset init, SHACL, serialization
  template.ts               Six-phase SSR template resolver
  transport.ts              ServerSSETransport (SSE client management)
src/components/
  profile-store.js          <profile-store>: CPXStore + collab over SSE
  profile-card.js           <profile-card>: read-only profile display
  profile-editor.js         <profile-editor>: form with two-way binding
  people-store.js           <people-store>: CPXStore for the people list
  people-list.js            <people-list>: live-updating person cards
  org-store.js              <org-store>: CPXStore + collab for a single org
  org-editor.js             <org-editor>: org edit form + delete
  orgs-store.js             <orgs-store>: CPXStore for the orgs list
  orgs-list.js              <orgs-list>: live-updating org cards, add/delete
src/utils/
  i18n.js                   Locale switching across document + shadow roots
  transform.js              Display transforms (capitalize, truncate, etc.)
templates/
  shell.html                App shell with nav, lang switcher, importmap
  profile.html              Profile view with declarative shadow DOM
  edit.html                 Editor view with declarative shadow DOM
  people.html               People listing with declarative shadow DOM
  org-edit.html             Org edit view with declarative shadow DOM
  orgs.html                 Org directory listing with declarative shadow DOM
rdf/
  profiles/                 Per-person Turtle files (ada, bob, carol)
  orgs/                     Per-org Turtle files (acme, globex, triplewave)
  shapes/person.ttl         SHACL validation shape for schema:Person
  ui.ttl                    UI labels as rdfs:label triples (en/fr/es)
css/                        Shadow DOM stylesheets per component
vendor/                     Pre-bundled cpx-store + vendored sparq WASM
```

## Running Locally

```sh
deno task dev
```

Opens at http://localhost:8000. The `--watch` flag restarts on file changes.

To rebuild the vendored cpx-store modules (only needed if upgrading the
dependency):

```sh
deno task vendor
```

## Key Dependencies

| Package | Role |
|---|---|
| [@sparq-org/sparq](https://github.com/sparq-org/sparq) | WASM RDF triplestore with SHACL validation |
| [@rdfjs/wrapper](https://github.com/rdfjs-base/wrapper) | Typed property access over RDF datasets |
| [@chapeaux/cpx-store](https://github.com/chapeaux/cpx-store) | Reactive state store with collab plugin and SSE transport |
| [@b-fuze/deno-dom](https://github.com/nicolo-ribaudo/deno-dom) | Server-side DOM for template resolution |
