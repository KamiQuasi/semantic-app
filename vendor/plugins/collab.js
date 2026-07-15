class LastWriterWinsResolver {
    resolve(local, remote) {
        return remote.timestamp >= local.timestamp ? remote : local;
    }
}
function collabPlugin(options) {
    const transport = options.transport;
    const clientId = options.clientId ?? crypto.randomUUID();
    const resolver = options.resolver ?? new LastWriterWinsResolver();
    let store;
    const operationLog = [];
    const latestLocalOps = new Map();
    function handleReceive(op) {
        if (op.origin === clientId) return;
        const localOp = latestLocalOps.get(op.prop);
        let opToApply = op;
        if (localOp) {
            opToApply = resolver.resolve(localOp, op);
            if (opToApply === localOp) return;
        }
        store.sync({
            [opToApply.prop]: opToApply.value
        });
        operationLog.push(op);
    }
    return {
        name: 'collab',
        onInit (s) {
            store = s;
            transport.onReceive(handleReceive);
            transport.connect();
            store.getOperationLog = ()=>[
                    ...operationLog
                ];
            store.connect = (newTransport, opts)=>{
                transport.disconnect();
                newTransport.onReceive(handleReceive);
                return newTransport.connect();
            };
            store.disconnect = ()=>{
                transport.disconnect();
            };
        },
        onAfterSet (prop, value, _oldValue) {
            if (store._isSyncing) return;
            const op = {
                id: crypto.randomUUID(),
                origin: clientId,
                timestamp: Date.now(),
                prop,
                type: 'set',
                value
            };
            operationLog.push(op);
            latestLocalOps.set(prop, op);
            transport.send(op);
        },
        onDestroy () {
            transport.disconnect();
        }
    };
}
export { collabPlugin as collabPlugin };
