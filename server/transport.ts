/** A collaborative state change operation transmitted over SSE. */
interface StateOperation {
  id: string;
  origin: string;
  timestamp: number;
  prop: string;
  type: 'set' | 'patch';
  value?: unknown;
}

/** Callback invoked when a state operation is received from a client. */
type ReceiveHandler = (op: StateOperation) => void;

/**
 * Server-side SSE transport that manages connected clients, broadcasts
 * state operations and named events, and dispatches incoming operations
 * to a registered handler.
 */
export class ServerSSETransport {
  _clients = new Set<ReadableStreamDefaultController>();
  _handler: ReceiveHandler | null = null;
  _encoder = new TextEncoder();

  /** Broadcast a state operation as an unnamed SSE data event to all clients. */
  send(op: StateOperation): void {
    const data = `data: ${JSON.stringify(op)}\n\n`;
    const encoded = this._encoder.encode(data);
    for (const controller of this._clients) {
      try {
        controller.enqueue(encoded);
      } catch {
        this._clients.delete(controller);
      }
    }
  }

  /** Broadcast a named SSE event (e.g. `"labels"`) with arbitrary data to all clients. */
  broadcastEvent(event: string, data: string): void {
    const msg = `event: ${event}\ndata: ${data}\n\n`;
    const encoded = this._encoder.encode(msg);
    for (const controller of this._clients) {
      try {
        controller.enqueue(encoded);
      } catch {
        this._clients.delete(controller);
      }
    }
  }

  /** Register the handler called when an operation is received. */
  onReceive(handler: ReceiveHandler): void {
    this._handler = handler;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {}

  addClient(controller: ReadableStreamDefaultController): void {
    this._clients.add(controller);
  }

  removeClient(controller: ReadableStreamDefaultController): void {
    this._clients.delete(controller);
  }

  /** Broadcast an operation to all clients and invoke the receive handler. */
  receive(op: StateOperation): void {
    this.send(op);
    if (this._handler) {
      this._handler(op);
    }
  }
}
