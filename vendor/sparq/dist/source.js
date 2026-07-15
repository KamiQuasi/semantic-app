import { DefaultGraph, NamedNode } from './terms.js';
const DEFAULT_GRAPH = new DefaultGraph();
/**
 * A minimal, browser-safe RDF/JS `Stream<Quad>` that PULLS quads lazily from an underlying
 * iterable (a generator over the store's match) rather than holding a materialised array. It
 * implements exactly the `EventEmitter` subset the RDF/JS Stream spec exercises (`on` / `once` /
 * `removeListener` / `off` / `emit` / `read`) rather than depending on `node:events`, so it runs
 * unchanged in the browser. It pulls one quad at a time: `read()` returns the next quad (or
 * `null` at end), and on the next microtask it drains the iterator, emitting a `data` event per
 * quad then `end` (or `error` if the iterator throws). Listeners attached synchronously after
 * construction still receive every event.
 *
 * It implements the `EventEmitter` SUBSET the RDF/JS Stream spec actually exercises rather than
 * the full `node:events` surface (so it stays browser-safe); call sites bridge to the full
 * `RDF.Stream` type via {@link asStream}.
 */
export class QuadStream {
    #iterator;
    #done = false;
    #flushed = false;
    #listeners = new Map();
    /**
     * @param source the quads to stream — any iterable (a generator/iterator-backed source is
     *   pulled lazily one quad at a time; an array is iterated without being copied). Defaults to
     *   an empty stream (for the consume/`removeMatches` paths that only ever emit `end`/`error`).
     */
    constructor(source = []) {
        this.#iterator = source[Symbol.iterator]();
        queueMicrotask(() => this.#flush());
    }
    /** Pulls the next quad from the underlying source, or `null` once exhausted (per the spec). */
    read() {
        if (this.#done)
            return null;
        const next = this.#iterator.next();
        if (next.done) {
            this.#done = true;
            return null;
        }
        return next.value;
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
    emit(event, arg) {
        const set = this.#listeners.get(String(event));
        if (!set || set.size === 0)
            return false;
        // Iterate the listener Set directly: a `once` wrapper deletes itself before invoking the
        // user callback, and deleting the current entry mid-iteration is well-defined for a Set.
        for (const listener of set)
            listener(arg);
        return true;
    }
    /** Drains the underlying iterator on the microtask, emitting `data` per quad then `end`. */
    #flush() {
        if (this.#flushed)
            return;
        this.#flushed = true;
        try {
            for (let next = this.#iterator.next(); !next.done; next = this.#iterator.next()) {
                this.#done = false;
                this.emit('data', next.value);
            }
            this.#done = true;
            this.emit('end');
        }
        catch (err) {
            this.#done = true;
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
    }
}
/**
 * Bridges a browser-safe {@link QuadStream} (which implements only the `EventEmitter` subset the
 * RDF/JS Stream spec exercises) to the full `RDF.Stream<Quad>` interface (whose nominal type
 * extends the whole `node:events` `EventEmitter`). The subset is exactly what consumers use, so
 * the cast is faithful — see the same pattern in `dataset.ts`.
 */
function asStream(s) {
    return s;
}
/**
 * [OPUS-4.8] sq-iwhl8 (#1116) — an RDF/JS **`Source`** + **`Sink`** + **`Store`** adapter over a
 * {@link SparqStore}. `Source.match` returns a quad `Stream` (the spec's event-based shape, not
 * the store's synchronous `Quad[]`); `Sink.import` / `Store.remove` consume a quad `Stream` and
 * return an EventEmitter that signals `end` / `error`; `removeMatches` / `deleteGraph` mutate by
 * pattern. The backing store stays the source of truth — the adapter only re-views its
 * synchronous primitives as the streaming interface, so a sparq store drops into any RDF/JS
 * pipeline that speaks the Stream spec (a parser sink, a serializer source, …).
 */
export class SparqSource {
    #store;
    constructor(store) {
        this.#store = store;
    }
    /** The backing {@link SparqStore} — the full SPARQL + delta surface. */
    get store() {
        return this.#store;
    }
    /**
     * RDF/JS `Source.match`: a quad `Stream` of the quads matching the pattern (wildcards are
     * `null`). The stream PULLS lazily from the store's {@link SparqStore.matchStream} generator —
     * which streams solutions from the engine in ~64 KiB chunks — so a very large match is never
     * materialised whole on the JS side.
     */
    match(subject, predicate, object, graph) {
        return asStream(new QuadStream(this.#store.matchStream(subject, predicate, object, graph)));
    }
    /**
     * RDF/JS `Sink.import` / `Store` insert: consumes the quad `Stream`, buffering its quads and
     * applying them as one O(batch) delta on `end`. Returns an EventEmitter that emits `end` once
     * the batch is applied (or `error` if it fails) — the spec's fire-and-forget consume contract.
     */
    import(stream) {
        return this.#consume(stream, (quads) => this.#store.addQuads(quads));
    }
    /** RDF/JS `Store.remove`: consumes the quad `Stream` and removes its quads as one O(batch) delta. */
    remove(stream) {
        return this.#consume(stream, (quads) => this.#store.removeQuads(quads));
    }
    /** RDF/JS `Store.removeMatches`: removes every quad matching the pattern; signals `end` when done. */
    removeMatches(subject, predicate, object, graph) {
        const out = new QuadStream();
        queueMicrotask(() => {
            try {
                const toRemove = this.#store.match(subject, predicate, object, graph);
                if (toRemove.length > 0)
                    this.#store.removeQuads(toRemove);
                out.emit('end');
            }
            catch (err) {
                out.emit('error', err instanceof Error ? err : new Error(String(err)));
            }
        });
        return asStream(out);
    }
    /**
     * RDF/JS `Store.deleteGraph`: removes every quad in the given graph. A `NamedNode`/`BlankNode`
     * (or a non-empty string IRI) targets that named graph; `DefaultGraph` or `''` targets the
     * default graph. Signals `end` when the batch is applied.
     */
    deleteGraph(graph) {
        const g = typeof graph === 'string' ? (graph === '' ? DEFAULT_GRAPH : new NamedNode(graph)) : graph;
        return this.removeMatches(undefined, undefined, undefined, g);
    }
    #consume(stream, apply) {
        const out = new QuadStream();
        const buffered = [];
        stream.on('data', (quad) => buffered.push(quad));
        stream.on('error', (err) => out.emit('error', err));
        stream.on('end', () => {
            try {
                if (buffered.length > 0)
                    apply(buffered);
                out.emit('end');
            }
            catch (err) {
                out.emit('error', err instanceof Error ? err : new Error(String(err)));
            }
        });
        return asStream(out);
    }
}
