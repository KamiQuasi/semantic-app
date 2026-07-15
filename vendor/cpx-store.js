let activeTracking = null;
class ReactiveState {
    _value;
    _subscribers = new Set();
    constructor(value){
        this._value = value;
    }
    get() {
        if (activeTracking) activeTracking.add(this);
        return this._value;
    }
    set(value) {
        if (Object.is(this._value, value)) return;
        this._value = value;
        for (const sub of this._subscribers){
            sub._markDirty();
        }
    }
}
class ReactiveComputed {
    _fn;
    _cache;
    _dirty = true;
    _deps = new Set();
    _subscribers = new Set();
    constructor(fn){
        this._fn = fn;
    }
    _markDirty() {
        if (this._dirty) return;
        this._dirty = true;
        for (const sub of this._subscribers){
            sub._markDirty();
        }
    }
    _retrack() {
        for (const dep of this._deps){
            dep._subscribers.delete(this);
        }
        this._deps.clear();
        const prev = activeTracking;
        activeTracking = new Set();
        this._cache = this._fn();
        this._deps = activeTracking;
        activeTracking = prev;
        for (const dep of this._deps){
            dep._subscribers.add(this);
        }
        this._dirty = false;
    }
    get() {
        if (activeTracking) activeTracking.add(this);
        if (this._dirty) this._retrack();
        return this._cache;
    }
}
function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val) && Object.getPrototypeOf(val) === Object.prototype;
}
const proxyCache = new WeakMap();
function getCachedProxy(target, path) {
    return proxyCache.get(target)?.get(path);
}
function setCachedProxy(target, path, proxy) {
    let map = proxyCache.get(target);
    if (!map) {
        map = new Map();
        proxyCache.set(target, map);
    }
    map.set(path, proxy);
}
function ensureSignal(store, fullPath, value) {
    let signal = store._signals.get(fullPath);
    if (!signal) {
        signal = new ReactiveState(value);
        store._signals.set(fullPath, signal);
    } else if (!Object.is(signal._value, value)) {
        signal._value = value;
    }
    return signal;
}
function createNestedProxy(obj, parentPath, store) {
    const cached = getCachedProxy(obj, parentPath);
    if (cached) return cached;
    const proxy = new Proxy(obj, {
        get (_target, prop) {
            const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
            const rawValue = _target[prop];
            if (isPlainObject(rawValue)) {
                ensureSignal(store, fullPath, rawValue).get();
                return createNestedProxy(rawValue, fullPath, store);
            }
            const signal = ensureSignal(store, fullPath, rawValue);
            return signal.get();
        },
        set (_target, prop, value) {
            const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
            store._setProperty(fullPath, value);
            return true;
        }
    });
    setCachedProxy(obj, parentPath, proxy);
    return proxy;
}
function CPXStoreCoreMixin(Base) {
    return class StoreBase extends Base {
        _state;
        _signals;
        _computedSignals;
        _plugins;
        _pendingChanges;
        _changeHandlers;
        _flushScheduled;
        _batchDepth;
        _isSyncing;
        _initialized;
        state;
        constructor(...args){
            super(...args);
        }
        _setup(initialState = {}, plugins = []) {
            this._state = {
                ...initialState
            };
            this._signals = new Map();
            this._computedSignals = new Map();
            this._plugins = [];
            this._pendingChanges = new Map();
            this._changeHandlers = new Set();
            this._flushScheduled = false;
            this._batchDepth = 0;
            this._isSyncing = false;
            this._initialized = false;
            for (const [key, value] of Object.entries(initialState)){
                this._signals.set(key, new ReactiveState(value));
            }
            for (const plugin of plugins){
                this.use(plugin);
            }
        }
        _resolveNestedPath(path) {
            const parts = path.split('.');
            let current = this._state;
            for(let i = 0; i < parts.length - 1; i++){
                if (!_isPlainObject(current)) return undefined;
                current = current[parts[i]];
            }
            if (!_isPlainObject(current)) return undefined;
            return {
                parent: current,
                key: parts[parts.length - 1]
            };
        }
        _setProperty(prop, value) {
            if (this._computedSignals.has(prop)) return;
            const isNested = prop.includes('.');
            let oldValue;
            if (isNested) {
                const resolved = this._resolveNestedPath(prop);
                if (!resolved) return;
                oldValue = resolved.parent[resolved.key];
            } else {
                oldValue = this._state[prop];
            }
            if (Object.is(oldValue, value)) return;
            for (const plugin of this._plugins){
                if (plugin.onBeforeSet) {
                    if (plugin.onBeforeSet(prop, value, oldValue) === false) return;
                }
            }
            if (isNested) {
                const resolved = this._resolveNestedPath(prop);
                if (resolved) resolved.parent[resolved.key] = value;
            } else {
                this._state[prop] = value;
            }
            const signal = this._signals.get(prop);
            if (signal) {
                signal.set(value);
            } else {
                this._signals.set(prop, new ReactiveState(value));
            }
            if (!this._pendingChanges.has(prop)) {
                this._pendingChanges.set(prop, {
                    old: oldValue,
                    val: value
                });
            } else {
                this._pendingChanges.get(prop).val = value;
            }
            for (const plugin of this._plugins){
                if (plugin.onAfterSet) plugin.onAfterSet(prop, value, oldValue);
            }
            this._scheduleFlush();
        }
        _init() {
            if (this._initialized) return;
            this._initialized = true;
            for (const plugin of this._plugins){
                if (plugin.onInit) plugin.onInit(this);
            }
            const self = this;
            this.state = new Proxy(this._state, {
                get: (_target, prop)=>{
                    const computed = self._computedSignals.get(prop);
                    if (computed) return computed.get();
                    for (const plugin of self._plugins){
                        if (plugin.onGet) {
                            const result = plugin.onGet(prop);
                            if (result && result.handled) return result.value;
                        }
                    }
                    const signal = self._signals.get(prop);
                    const value = signal ? signal.get() : _target[prop];
                    if (_isPlainObject(value)) {
                        return createNestedProxy(value, prop, self);
                    }
                    return value;
                },
                set: (_target, prop, value)=>{
                    self._setProperty(prop, value);
                    return true;
                },
                deleteProperty: (_target, prop)=>{
                    if (prop in _target) {
                        const oldValue = _target[prop];
                        delete _target[prop];
                        self._signals.delete(prop);
                        self._pendingChanges.set(prop, {
                            old: oldValue,
                            val: undefined
                        });
                        self._scheduleFlush();
                    }
                    return true;
                },
                has: (_target, prop)=>{
                    return self._computedSignals.has(prop) || prop in _target;
                },
                ownKeys: (_target)=>{
                    return [
                        ...Object.keys(_target),
                        ...self._computedSignals.keys()
                    ];
                },
                getOwnPropertyDescriptor: (_target, prop)=>{
                    if (self._computedSignals.has(prop)) {
                        return {
                            configurable: true,
                            enumerable: true,
                            value: self._computedSignals.get(prop).get()
                        };
                    }
                    return Object.getOwnPropertyDescriptor(_target, prop);
                }
            });
        }
        _destroy() {
            for (const plugin of this._plugins){
                if (plugin.onDestroy) plugin.onDestroy();
            }
            this._changeHandlers.clear();
        }
        use(plugin) {
            this._plugins.push(plugin);
            return this;
        }
        computed(name, fn) {
            this._computedSignals.set(name, new ReactiveComputed(fn));
        }
        onChange(handler) {
            this._changeHandlers.add(handler);
            return ()=>{
                this._changeHandlers.delete(handler);
            };
        }
        _emitChanges(changes) {
            for (const handler of this._changeHandlers){
                handler(changes);
            }
        }
        _scheduleFlush() {
            if (this._batchDepth > 0) return;
            if (this._flushScheduled) return;
            this._flushScheduled = true;
            queueMicrotask(()=>this._flush());
        }
        _flush() {
            this._flushScheduled = false;
            if (this._pendingChanges.size === 0) return;
            const changes = new Map();
            for (const [prop, change] of this._pendingChanges){
                if (!Object.is(change.old, change.val)) changes.set(prop, change);
            }
            this._pendingChanges.clear();
            if (changes.size === 0) return;
            for (const plugin of this._plugins){
                if (plugin.onFlush) plugin.onFlush(changes);
            }
            this._emitChanges(changes);
        }
        batch(fn) {
            this._batchDepth++;
            try {
                fn();
            } finally{
                this._batchDepth--;
                if (this._batchDepth === 0) this._flush();
            }
        }
        transaction(fn) {
            const snapshot = {
                ...this._state
            };
            const signalSnapshot = new Map();
            for (const [k, s] of this._signals)signalSnapshot.set(k, s._value);
            this._batchDepth++;
            try {
                fn();
                this._batchDepth--;
                if (this._batchDepth === 0) this._flush();
            } catch (e) {
                this._batchDepth--;
                Object.keys(this._state).forEach((k)=>delete this._state[k]);
                Object.assign(this._state, snapshot);
                for (const [k, val] of signalSnapshot){
                    const s = this._signals.get(k);
                    if (s) s._value = val;
                }
                this._pendingChanges.clear();
                throw e;
            }
        }
        async dispatch(action) {
            this._batchDepth++;
            try {
                await action(this.state);
                this._batchDepth--;
                if (this._batchDepth === 0) this._flush();
            } catch (error) {
                this._batchDepth--;
                if (this._batchDepth === 0) this._flush();
                throw error;
            }
        }
        sync(incoming) {
            this._isSyncing = true;
            const oldState = {
                ...this._state
            };
            this.batch(()=>{
                for (const [key, value] of Object.entries(incoming)){
                    this.state[key] = value;
                }
            });
            this._isSyncing = false;
            this.onSyncReceived({
                ...this._state
            }, oldState);
        }
        onSyncReceived(_newState, _oldState) {}
        undo() {}
        redo() {}
        toJSON() {
            return {
                ...this._state
            };
        }
    };
}
function _isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val) && Object.getPrototypeOf(val) === Object.prototype;
}
CPXStoreCoreMixin(class {
});
const WebComponentBase = CPXStoreCoreMixin(HTMLElement);
class CPXStore extends WebComponentBase {
    constructor(initialState = {}, ...plugins){
        super();
        this._setup(initialState, plugins);
    }
    connectedCallback() {
        this._init();
        this.onChange((changes)=>{
            this.dispatchEvent(new CustomEvent('change', {
                detail: {
                    changes: Object.fromEntries(changes)
                },
                bubbles: true
            }));
            globalThis.dispatchEvent(new CustomEvent('app-state-update', {
                detail: {
                    store: this.tagName,
                    changes: Object.fromEntries(changes)
                }
            }));
        });
    }
    disconnectedCallback() {
        this._destroy();
    }
    async dispatch(action) {
        this._batchDepth++;
        try {
            await action(this.state);
            this._batchDepth--;
            if (this._batchDepth === 0) this._flush();
        } catch (error) {
            this._batchDepth--;
            if (this._batchDepth === 0) this._flush();
            this.dispatchEvent(new CustomEvent('dispatch-error', {
                detail: {
                    error
                },
                bubbles: true
            }));
            throw error;
        }
    }
}
export { CPXStore as CPXStore };
