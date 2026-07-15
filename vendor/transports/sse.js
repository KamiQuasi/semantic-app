class SSETransport {
    _eventsUrl;
    _apiUrl;
    _headers;
    _eventSource = null;
    _handler = null;
    _queue = [];
    _connected = false;
    _intentionalClose = false;
    _reconnectDelay = 1000;
    _maxReconnectDelay = 30000;
    _reconnectTimer = null;
    constructor(eventsUrl, options = {}){
        this._eventsUrl = eventsUrl;
        this._apiUrl = options.apiUrl;
        this._headers = options.headers ?? {};
    }
    send(op) {
        if (!this._apiUrl) return;
        if (this._connected) {
            this._doSend(op);
        } else {
            this._queue.push(op);
        }
    }
    onReceive(handler) {
        this._handler = handler;
    }
    connect() {
        this._intentionalClose = false;
        this._reconnectDelay = 1000;
        return this._doConnect();
    }
    _doConnect() {
        return new Promise((resolve, reject)=>{
            try {
                this._eventSource = new EventSource(this._eventsUrl);
            } catch (e) {
                reject(e);
                return;
            }
            this._eventSource.onopen = ()=>{
                this._connected = true;
                this._reconnectDelay = 1000;
                this._flushQueue();
                resolve();
            };
            this._eventSource.onmessage = (event)=>{
                if (this._handler) {
                    try {
                        const op = JSON.parse(event.data);
                        this._handler(op);
                    } catch  {}
                }
            };
            this._eventSource.onerror = ()=>{
                const wasConnected = this._connected;
                this._connected = false;
                if (this._eventSource) {
                    this._eventSource.close();
                    this._eventSource = null;
                }
                if (!wasConnected) {
                    reject(new Error('SSE connection failed'));
                } else if (!this._intentionalClose) {
                    this._scheduleReconnect();
                }
            };
        });
    }
    _doSend(op) {
        fetch(this._apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this._headers
            },
            body: JSON.stringify(op)
        }).catch(()=>{
            this._queue.push(op);
        });
    }
    _flushQueue() {
        while(this._queue.length > 0 && this._connected && this._apiUrl){
            const op = this._queue.shift();
            this._doSend(op);
        }
    }
    _scheduleReconnect() {
        if (this._intentionalClose) return;
        this._reconnectTimer = setTimeout(()=>{
            this._reconnectTimer = null;
            this._doConnect().catch(()=>{});
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    }
    disconnect() {
        this._intentionalClose = true;
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._eventSource) {
            this._eventSource.close();
            this._eventSource = null;
        }
        this._connected = false;
    }
}
export { SSETransport as SSETransport };
