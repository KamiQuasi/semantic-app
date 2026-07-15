import { quadsToNQuads, termToNT } from './sparql.js';
import { SparqStore } from './store.js';
import { canonicalizeNQuads } from './wasm.js';
/**
 * An RDF/JS **`Dataset`** backed by the sparq wasm engine. Construct via the async factories
 * ({@link Dataset.create} / {@link Dataset.fromString} / {@link Dataset.fromQuads}), which
 * lazily instantiate the wasm engine on first use; thereafter the `Dataset` members are
 * synchronous per the spec. Mutations (`add` / `delete` / `addAll` / `deleteMatches`) go through
 * the engine's O(batch) delta overlay — no index rebuild.
 */
export class Dataset {
    #store;
    constructor(store) {
        this.#store = store;
    }
    // --- factories ---------------------------------------------------------------------------------
    /**
     * An EMPTY dataset. Awaits the (memoised) wasm `init()` first — this is the lazy-load point:
     * the engine binary is fetched here, not when the module is imported. The dataset is created
     * with named-graph awareness so the set algebra round-trips quads in any graph faithfully;
     * pass `{ dataset: false }` to fold named graphs into the default graph.
     */
    static async create(options = {}) {
        return new Dataset(await SparqStore.fromString('', 'ntriples', { dataset: true, ...options }));
    }
    /**
     * Parses an RDF document into a dataset (lazily instantiating the wasm engine first).
     * `format` and `options` mirror {@link SparqStore.fromString}. Named graphs (from
     * N-Quads / TriG / a JSON-LD `@graph`) are preserved by default so `match`/`size`/the set
     * algebra are graph-aware; pass `{ dataset: false }` to fold them into the default graph.
     */
    static async fromString(data, format = 'turtle', options = {}) {
        return new Dataset(await SparqStore.fromString(data, format, { dataset: true, ...options }));
    }
    /**
     * Builds a dataset from RDF/JS quads (lazily instantiating the wasm engine first). Each quad's
     * graph is preserved by default (`{ dataset: true }`).
     */
    static async fromQuads(quads, options = {}) {
        return new Dataset(await SparqStore.fromQuads(quads, { dataset: true, ...options }));
    }
    /**
     * Wraps an already-built {@link SparqStore} as a `Dataset` (no re-parse). The wasm engine is
     * assumed already initialised. Internal — used to materialise the result of a set op.
     */
    static fromStore(store) {
        return new Dataset(store);
    }
    /** A NEW sparq-backed dataset over `quads`, built synchronously (engine already up). */
    static of(quads) {
        return new Dataset(SparqStore.fromQuadsSync(quads, { dataset: true }));
    }
    /**
     * [OPUS-4.8] sq-iwhl8 (#1116) — a SYNCHRONOUS dataset factory, the building block for the
     * RDF/JS {@link RDF.DatasetCoreFactory} / {@link RDF.DatasetFactory} ({@link datasetFactory})
     * the conformance harness drives. Like {@link fromQuads} but WITHOUT `await init()`: the wasm
     * engine must ALREADY be initialised (a prior `await init()` / `await Dataset.create()` has
     * resolved), so the spec's synchronous `dataset(quads?)` factory shape can be satisfied. Prefer
     * the async {@link create} / {@link fromQuads} for first construction.
     */
    static fromQuadsSync(quads = []) {
        return Dataset.of(quads);
    }
    // --- DatasetCore -------------------------------------------------------------------------------
    /**
     * The backing {@link SparqStore} — the full SPARQL engine surface (`queryBindings`, `update`,
     * `queryQuads`, SHACL `validate`, streaming cursors, …). The `Dataset` and its store share one
     * wasm handle.
     */
    get store() {
        return this.#store;
    }
    /** The number of quads across the default graph AND every named graph (graph-spanning). */
    get size() {
        return this.#store.countQuads(null, null, null, null);
    }
    /**
     * Adds a quad through the engine's O(batch) delta overlay (idempotent — the store is a set).
     * Returns `this` per the RDF/JS spec.
     */
    add(quad) {
        this.#store.addQuads([quad]);
        return this;
    }
    /**
     * Removes a quad through the engine's O(batch) delta overlay (a no-op if absent). Returns
     * `this` per the RDF/JS spec.
     */
    delete(quad) {
        this.#store.removeQuads([quad]);
        return this;
    }
    /** Whether the dataset contains `quad` (graph-aware). */
    has(quad) {
        return this.#store.countQuads(quad.subject, quad.predicate, quad.object, quad.graph) > 0;
    }
    /**
     * Returns a NEW {@link Dataset} with the quads matching the given term pattern
     * (`null`/`undefined` positions are wildcards; the graph wildcard spans the default graph and
     * every named graph), per RDF/JS quad matching. The result is an independent dataset (its own
     * engine handle); mutating it does not affect this one.
     */
    match(subject, predicate, object, graph) {
        return Dataset.of(this.#store.match(subject, predicate, object, graph));
    }
    /**
     * Iterates every quad across the default graph and all named graphs. The materialised array is
     * built once via the store's graph-spanning `match()`; for a very large dataset prefer the
     * backing {@link store}'s streaming surface (`queryQuadsStream` / `queryBindingsStream`).
     */
    [Symbol.iterator]() {
        return this.#store.match(null, null, null, null)[Symbol.iterator]();
    }
    // --- Dataset: mutation -------------------------------------------------------------------------
    /**
     * Imports the quads (a sparq {@link Dataset}, a foreign RDF/JS dataset, or a `Quad[]`) into
     * THIS dataset, through one O(batch) delta. Unlike {@link union} this mutates the receiver
     * rather than returning a new dataset. Returns `this`.
     */
    addAll(quads) {
        this.#store.addQuads(toQuadArray(quads));
        return this;
    }
    /**
     * Removes the quads matching the given pattern from THIS dataset (graph-aware wildcards), per
     * RDF/JS quad matching. Returns `this`.
     */
    deleteMatches(subject, predicate, object, graph) {
        const toDelete = this.#store.match(subject, predicate, object, graph);
        if (toDelete.length > 0)
            this.#store.removeQuads(toDelete);
        return this;
    }
    // --- Dataset: set algebra (interop-aware) ------------------------------------------------------
    /**
     * Returns a NEW dataset that is the union of this dataset and `quads`. INTEROP: `quads` may be
     * another sparq {@link Dataset} (FAST native path — its quads are bulk-serialised once) or any
     * FOREIGN RDF/JS dataset / `Quad[]` (GENERIC quad-stream path); either way the engine
     * deduplicates as a set.
     */
    union(quads) {
        const out = SparqStore.fromQuadsSync(this.#store.match(null, null, null, null), { dataset: true });
        out.addQuads(toQuadArray(quads));
        return Dataset.fromStore(out);
    }
    /**
     * Returns a NEW dataset of the quads in this dataset that are ALSO in `quads`. INTEROP: `quads`
     * may be a sparq {@link Dataset} or any foreign RDF/JS dataset / `Quad[]`.
     */
    intersection(quads) {
        const other = new QuadSet(quads);
        const kept = [];
        for (const q of this)
            if (other.has(q))
                kept.push(q);
        return Dataset.of(kept);
    }
    /**
     * Returns a NEW dataset of the quads in this dataset that are NOT in `quads`. INTEROP: `quads`
     * may be a sparq {@link Dataset} or any foreign RDF/JS dataset / `Quad[]`.
     */
    difference(quads) {
        const other = new QuadSet(quads);
        const kept = [];
        for (const q of this)
            if (!other.has(q))
                kept.push(q);
        return Dataset.of(kept);
    }
    /**
     * Whether this dataset is a SUPERSET of `quads` — every quad of `quads` is present here, with
     * **blank nodes normalized** per the RDF/JS spec (matched by RDF-dataset isomorphism, not by
     * label). INTEROP: `quads` may be a sparq {@link Dataset} or any foreign RDF/JS dataset /
     * `Quad[]`.
     *
     * [OPUS-4.8] sq-1dd5t (#1047): now isomorphism-aware. When the operand carries no blank nodes
     * the fast exact-label membership test is used (blank-node relabelling cannot matter). When it
     * does, containment is "`E` maps into `D`": there is a consistent assignment of `E`'s blank
     * nodes to `D`'s terms such that every quad of `E` becomes a quad of `D` (ground terms fixed).
     * So a subgraph whose blank nodes are relabelled — even an isomorphic copy — is recognised as
     * contained. This is the blank-node homomorphism the spec's "differences in blank node labels
     * are ignored" entails; it is found by a bounded backtracking search ({@link containsByMapping}).
     */
    contains(quads) {
        const otherQuads = toQuadArray(quads);
        // Fast, exact path: with no blank nodes in the operand, label equality IS the test.
        if (!anyBlankNode(otherQuads)) {
            for (const q of otherQuads)
                if (!this.has(q))
                    return false;
            return true;
        }
        return containsByMapping(this.toArray(), otherQuads);
    }
    /**
     * Whether this dataset denotes the SAME RDF dataset as `quads` — mutual containment, with
     * **blank nodes normalized** (RDF-dataset isomorphism). INTEROP: `quads` may be a sparq
     * {@link Dataset} or any foreign RDF/JS dataset / `Quad[]`.
     *
     * [OPUS-4.8] sq-1dd5t (#1047): equality is now decided by RDFC-1.0 — two datasets are equal
     * iff their canonical N-Quads are byte-identical — so two isomorphic datasets that differ only
     * in blank-node labels (and/or quad order) compare equal. When neither side carries blank
     * nodes this short-circuits to the fast exact-label set comparison.
     */
    equals(quads) {
        const otherQuads = toQuadArray(quads);
        if (!anyBlankNode(otherQuads) && !this.#hasBlankNode()) {
            const other = new QuadSet(otherQuads);
            if (other.size !== this.size)
                return false;
            for (const q of this)
                if (!other.has(q))
                    return false;
            return true;
        }
        return this.toCanonical() === canonicalizeNQuads(quadsToNQuads(otherQuads));
    }
    /** Whether any quad of this dataset carries a blank node in any position. */
    #hasBlankNode() {
        return anyBlankNode(this.toArray());
    }
    // --- Dataset: iteration helpers ----------------------------------------------------------------
    /** `Array.prototype.every` over the quads. Short-circuits on the first failing quad. */
    every(iteratee) {
        for (const q of this)
            if (!iteratee(q, this))
                return false;
        return true;
    }
    /** `Array.prototype.some` over the quads. Short-circuits on the first passing quad. */
    some(iteratee) {
        for (const q of this)
            if (iteratee(q, this))
                return true;
        return false;
    }
    /** A NEW dataset of the quads for which `iteratee` returns truthy (`Array.prototype.filter`). */
    filter(iteratee) {
        const kept = [];
        for (const q of this)
            if (iteratee(q, this))
                kept.push(q);
        return Dataset.of(kept);
    }
    /** A NEW dataset of `iteratee` applied to each quad (`Array.prototype.map`). */
    map(iteratee) {
        const mapped = [];
        for (const q of this)
            mapped.push(iteratee(q, this));
        return Dataset.of(mapped);
    }
    /** `Array.prototype.forEach` over the quads. */
    forEach(callback) {
        for (const q of this)
            callback(q, this);
    }
    /** `Array.prototype.reduce` over the quads (with or without an initial value). */
    reduce(callback, initialValue) {
        let acc = initialValue;
        let seeded = arguments.length >= 2;
        for (const q of this) {
            if (!seeded) {
                acc = q;
                seeded = true;
            }
            else {
                acc = callback(acc, q, this);
            }
        }
        if (!seeded)
            throw new TypeError('reduce of empty dataset with no initial value');
        return acc;
    }
    // --- Dataset: materialisation ------------------------------------------------------------------
    /** The quads as a host-language array (order arbitrary — a `Dataset` is an unordered set). */
    toArray() {
        return this.#store.match(null, null, null, null);
    }
    /**
     * Imports all quads from an RDF/JS quad `Stream` into this dataset; resolves with `this` on the
     * stream's `end`, rejects on `error`. Quads are buffered and applied as one O(batch) delta on
     * `end` (the stream-spec contract is fire-and-forget per quad, so a single batch is faithful and
     * far cheaper than per-quad deltas).
     */
    import(stream) {
        return new Promise((resolve, reject) => {
            const buffered = [];
            stream.on('data', (quad) => buffered.push(quad));
            stream.on('error', (err) => reject(err));
            stream.on('end', () => {
                try {
                    if (buffered.length > 0)
                        this.#store.addQuads(buffered);
                    resolve(this);
                }
                catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
        });
    }
    /** A readable RDF/JS `Stream` over every quad of the dataset. */
    toStream() {
        // `ArrayQuadStream` implements the EventEmitter SUBSET the RDF/JS stream spec actually
        // exercises (`on`/`once`/`emit`/`removeListener`/`read`) without pulling in `node:events`
        // (so it stays browser-safe); the cast bridges to the full `EventEmitter`-typed interface.
        return new ArrayQuadStream(this.toArray());
    }
    /**
     * An N-Quads serialisation of the dataset (no normalization — the RDF/JS `toString` contract).
     * Order is arbitrary.
     */
    toString() {
        return quadsToNQuads(this.toArray());
    }
    /**
     * The dataset's **RDFC-1.0** (RDF Dataset Canonicalization / URDNA2015 successor) canonical
     * N-Quads — the form the RDF/JS spec defines `toCanonical` against. Blank-node labels are
     * **relabelled to a canonical form** (`_:c14nN`) and the quad lines are canonically sorted, so
     * two datasets that are RDF-isomorphic (differ only in blank-node labels and/or quad order)
     * produce byte-identical output. This is the basis for dataset hashing, equality and diffing.
     *
     * [OPUS-4.8] sq-1dd5t (#1047): computed by the engine's RDFC-1.0 implementation
     * (`sparq-canon` → the W3C-suite-validated `rdf-canon`) surfaced through the wasm
     * `canonicalizeNQuads` binding — no longer the label-sensitive sorted-N-Quads approximation.
     * RDF-1.2 triple terms are outside the W3C RDFC-1.0 data model and throw.
     */
    toCanonical() {
        return canonicalizeNQuads(quadsToNQuads(this.toArray()));
    }
    // --- lifecycle ---------------------------------------------------------------------------------
    /** Releases the wasm-side memory. The dataset must not be used afterwards. */
    free() {
        this.#store.free();
    }
    [Symbol.dispose]() {
        this.free();
    }
}
/**
 * [OPUS-4.8] sq-iwhl8 (#1116) — the RDF/JS **`DatasetCoreFactory`** AND **`DatasetFactory`**
 * (the latter extends the former; the sparq {@link Dataset} is a full `Dataset`, so one object
 * satisfies both). Its single `dataset(quads?)` method is SYNCHRONOUS per the spec, so the wasm
 * engine must already be initialised — `await init()` (or any `await Dataset.create()` /
 * `Dataset.fromString(...)`) before the first `dataset()` call, exactly as the synchronous
 * `Dataset` members require. This is what the RDF/JS conformance harness drives as a
 * `DatasetFactory`.
 */
export const datasetFactory = {
    dataset(quads) {
        return Dataset.fromQuadsSync(quads ?? []);
    },
};
// --- interop helpers -----------------------------------------------------------------------------
/** Iterates any quad source (a sparq `Dataset`, a foreign RDF/JS dataset/store, or a `Quad[]`). */
function toIterable(quads) {
    return quads;
}
/** Materialises any quad source to an array (a fast no-op when it already is one). */
function toQuadArray(quads) {
    return Array.isArray(quads) ? quads : [...quads];
}
/** Whether any quad in `quads` carries a `BlankNode` in subject, predicate, object or graph. */
function anyBlankNode(quads) {
    for (const q of quads) {
        if (q.subject.termType === 'BlankNode' ||
            q.object.termType === 'BlankNode' ||
            q.graph.termType === 'BlankNode') {
            return true;
        }
    }
    return false;
}
/**
 * [OPUS-4.8] sq-1dd5t: decides blank-node-aware containment — whether `pattern` (the `contains`
 * operand) maps into `data` (this dataset): is there a consistent assignment μ of `pattern`'s
 * blank nodes to `data`'s terms such that μ(`pattern`) ⊆ `data`? Ground terms are fixed; only the
 * operand's blank nodes are variables. This is exactly the "differences in blank node labels are
 * ignored" of the RDF/JS `contains` spec — a relabelled (even isomorphic) subgraph is contained.
 *
 * Found by a backtracking search: the operand's quads are ordered most-constrained-first (fewest
 * candidate matches in `data`) and assigned one at a time, propagating μ. Subgraph matching is
 * NP-hard in the worst case, so the search is bounded by {@link CONTAINS_STEP_BUDGET}; on
 * exceeding it the method FAILS CLOSED (returns `false`) rather than running unbounded — a
 * conservative answer for a pathological operand, never a wrong `true`.
 */
function containsByMapping(data, pattern) {
    // Index `data` by its concrete terms so a candidate lookup for one operand quad is cheap.
    const dataKeys = new Set();
    for (const q of data)
        dataKeys.add(quadKey(q));
    // Operand quads that are fully ground must already be present verbatim.
    const open = [];
    for (const q of pattern) {
        if (quadHasBlank(q))
            open.push(q);
        else if (!dataKeys.has(quadKey(q)))
            return false;
    }
    if (open.length === 0)
        return true;
    // Candidate sets: for each open operand quad, the data quads it could map onto (same ground
    // positions; blank positions are wildcards here, pinned during the search).
    const candidates = open.map((pq) => data.filter((dq) => quadMatchesPattern(dq, pq)));
    // Most-constrained-first: assign the operand quad with the fewest candidates earliest.
    const order = open.map((_, i) => i).sort((a, b) => candidates[a].length - candidates[b].length);
    const mapping = new Map(); // operand bnode label -> data term key (`_:x` / IRI / literal NT)
    let steps = 0;
    const search = (k) => {
        if (k === order.length)
            return true;
        if (++steps > CONTAINS_STEP_BUDGET)
            return false;
        const idx = order[k];
        const pq = open[idx];
        for (const dq of candidates[idx]) {
            const undo = [];
            if (unify(pq, dq, mapping, undo)) {
                if (search(k + 1))
                    return true;
            }
            for (const key of undo)
                mapping.delete(key); // backtrack
        }
        return false;
    };
    return search(0);
}
/** Tries to extend `mapping` so operand quad `pq` maps onto data quad `dq`; records new keys in `undo`. */
function unify(pq, dq, mapping, undo) {
    return (unifyTerm(pq.subject, dq.subject, mapping, undo) &&
        unifyTerm(pq.object, dq.object, mapping, undo) &&
        unifyTerm(pq.graph, dq.graph, mapping, undo)
    // predicate is always an IRI (no blank nodes), so it is compared structurally by quadMatchesPattern
    );
}
/** Unifies one operand term `pt` with the data term `dt`, binding `pt` if it is a blank node. */
function unifyTerm(pt, dt, mapping, undo) {
    if (pt.termType !== 'BlankNode')
        return termKey(pt) === termKey(dt);
    const dtKey = termKey(dt);
    const bound = mapping.get(pt.value);
    if (bound !== undefined)
        return bound === dtKey;
    mapping.set(pt.value, dtKey);
    undo.push(pt.value);
    return true;
}
/** Whether a data quad `dq` could match operand quad `pq` on its NON-blank (fixed) positions. */
function quadMatchesPattern(dq, pq) {
    return (posMatches(pq.subject, dq.subject) &&
        termKey(pq.predicate) === termKey(dq.predicate) &&
        posMatches(pq.object, dq.object) &&
        posMatches(pq.graph, dq.graph));
}
/** A blank operand position matches any data term of a compatible KIND; a fixed one must be equal. */
function posMatches(pt, dt) {
    if (pt.termType === 'BlankNode')
        return dt.termType === 'BlankNode'; // bnode maps only to a bnode
    return termKey(pt) === termKey(dt);
}
function quadHasBlank(q) {
    return (q.subject.termType === 'BlankNode' ||
        q.object.termType === 'BlankNode' ||
        q.graph.termType === 'BlankNode');
}
/** A stable string key for a term (the N-Triples form is exact for IRIs/literals; bnodes keyed by label). */
function termKey(t) {
    return t.termType === 'BlankNode'
        ? `_:${t.value}`
        : t.termType === 'DefaultGraph'
            ? ''
            : termToNT(t);
}
function quadKey(q) {
    return `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)} ${termKey(q.graph)}`;
}
/**
 * Step budget for the {@link containsByMapping} blank-node backtracking search. Subgraph matching
 * is NP-hard, so a pathological operand could otherwise run unbounded; on exceeding this the
 * search fails closed (returns `false`). Generous for the realistic small-operand `contains` use.
 */
const CONTAINS_STEP_BUDGET = 200_000;
/**
 * A membership set over quads keyed on their N-Quads serialisation — the basis for the
 * INTEROP-aware `intersection` / `difference` / `equals`. Building it from a FOREIGN RDF/JS
 * dataset only relies on `[Symbol.iterator]` (which `DatasetCore` mandates), so an `N3.Store`,
 * an `@rdfjs/dataset`, or a plain `Quad[]` all work; a sparq {@link Dataset} iterates the same
 * way. Keying on N-Quads gives RDF/JS `Quad.equals` semantics (term-by-term, blank nodes by
 * label) without an O(n·m) pairwise scan.
 */
class QuadSet {
    #keys;
    constructor(quads) {
        this.#keys = new Set();
        for (const q of toIterable(quads))
            this.#keys.add(quadsToNQuads([q]));
    }
    has(quad) {
        return this.#keys.has(quadsToNQuads([quad]));
    }
    get size() {
        return this.#keys.size;
    }
}
/**
 * A minimal, browser-safe RDF/JS `Stream` over an in-memory array of quads (for {@link
 * Dataset.toStream}). It implements just the `EventEmitter` surface the RDF/JS stream spec needs
 * (`on` / `once` / `emit` / `removeListener`) rather than depending on `node:events`, so it runs
 * unchanged in the browser. Emits `data` for each quad then `end` on the next microtask, so
 * listeners attached synchronously after the call still receive every event. Also `read()`-able
 * per the stream spec.
 */
class ArrayQuadStream {
    #quads;
    #i = 0;
    #flushed = false;
    #listeners = new Map();
    constructor(quads) {
        this.#quads = quads;
        queueMicrotask(() => this.#flush());
    }
    read() {
        return this.#i < this.#quads.length ? this.#quads[this.#i++] : null;
    }
    on(event, listener) {
        const key = String(event);
        let set = this.#listeners.get(key);
        if (!set)
            this.#listeners.set(key, (set = new Set()));
        set.add(listener);
        return this;
    }
    once(event, listener) {
        const wrapper = (arg) => {
            this.removeListener(event, wrapper);
            listener(arg);
        };
        return this.on(event, wrapper);
    }
    removeListener(event, listener) {
        this.#listeners.get(String(event))?.delete(listener);
        return this;
    }
    off(event, listener) {
        return this.removeListener(event, listener);
    }
    emit(event, ...args) {
        const set = this.#listeners.get(String(event));
        if (!set || set.size === 0)
            return false;
        for (const listener of [...set])
            listener(args[0]);
        return true;
    }
    #flush() {
        if (this.#flushed)
            return;
        this.#flushed = true;
        for (const q of this.#quads)
            this.emit('data', q);
        this.emit('end');
    }
}
