import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { renderPage } from './server/template.ts';
import { ServerSSETransport } from './server/transport.ts';
import {
  parseTurtle,
  getProfile,
  toState,
  updateFromState,
  serializeTurtle,
  loadLabels,
  type Labels,
} from './server/rdf.ts';

const UI_PATH = 'rdf/ui.ttl';
const PROFILE_PATH = 'rdf/profile.ttl';
const RDF_DIR = 'rdf';

const n3Store = parseTurtle(await Deno.readTextFile(PROFILE_PATH));
let labels: Labels = loadLabels(parseTurtle(await Deno.readTextFile(UI_PATH)));

/** Convert a Labels map to a JSON-serializable object for SSE broadcast. */
function serializeLabels(l: Labels): string {
  const obj: Record<string, Record<string, string>> = {};
  for (const [subject, langMap] of l) {
    const langs: Record<string, string> = {};
    for (const [lang, text] of langMap) langs[lang] = text;
    obj[subject] = langs;
  }
  return JSON.stringify(obj);
}

const profile = getProfile(n3Store);
const serverTransport = new ServerSSETransport();
const store = new CPXStoreCore(
  toState(profile),
  collabPlugin({ transport: serverTransport }),
);

let lastSelfWrite = 0;
let fileReloading = false;

store.onChange((changes) => {
  if (fileReloading) return;
  for (const [prop, { val }] of changes) {
    updateFromState(profile, prop, val);
  }
  lastSelfWrite = Date.now();
  Deno.writeTextFile(PROFILE_PATH, serializeTurtle(n3Store));
});

let labelsDebounce: number | undefined;
let profileDebounce: number | undefined;

(async () => {
  const watcher = Deno.watchFs(RDF_DIR);
  for await (const event of watcher) {
    if (event.kind !== 'modify' && event.kind !== 'create' && event.kind !== 'rename') continue;

    if (event.paths.some((p) => p.endsWith('ui.ttl'))) {
      clearTimeout(labelsDebounce);
      labelsDebounce = setTimeout(async () => {
        try {
          labels = loadLabels(parseTurtle(await Deno.readTextFile(UI_PATH)));
          serverTransport.broadcastEvent('labels', serializeLabels(labels));
          console.log('Labels reloaded and broadcast from', UI_PATH);
        } catch (e) {
          console.error('Failed to reload labels:', e);
        }
      }, 100);
    }

    if (event.paths.some((p) => p.endsWith('profile.ttl'))) {
      if (Date.now() - lastSelfWrite < 1000) continue;
      clearTimeout(profileDebounce);
      profileDebounce = setTimeout(async () => {
        try {
          const ttl = await Deno.readTextFile(PROFILE_PATH);
          const fileStore = parseTurtle(ttl);
          const fileProfile = getProfile(fileStore);
          const newState = toState(fileProfile);

          const oldState = store.toJSON() as Record<string, unknown>;
          const changed: [string, unknown][] = [];
          for (const [key, val] of Object.entries(newState)) {
            if (JSON.stringify(val) !== JSON.stringify(oldState[key])) {
              changed.push([key, val]);
            }
          }
          if (!changed.length) return;

          n3Store.removeQuads(n3Store.getQuads(null, null, null, null));
          n3Store.addQuads(fileStore.getQuads(null, null, null, null));

          fileReloading = true;
          for (const [key, val] of changed) {
            serverTransport.receive({
              id: crypto.randomUUID(),
              origin: 'file',
              timestamp: Date.now(),
              prop: key,
              type: 'set',
              value: val,
            });
          }
          fileReloading = false;
          console.log('Profile reloaded and broadcast from', PROFILE_PATH);
        } catch (e) {
          fileReloading = false;
          console.error('Failed to reload profile:', e);
        }
      }, 100);
    }
  }
})();

/** File extension to Content-Type mapping for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ttl': 'text/turtle; charset=utf-8',
};

/** Serve a static file from disk, returning null if not found. */
async function serveStatic(path: string): Promise<Response | null> {
  try {
    const file = await Deno.readFile('.' + path);
    const ext = path.substring(path.lastIndexOf('.'));
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    return new Response(file, {
      headers: { 'Content-Type': contentType },
    });
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

Deno.serve({ port: 8000, automaticCompression: true }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/') {
    return Response.redirect(new URL('/profile', req.url), 302);
  }

  if (path === '/profile' || path === '/edit') {
    const page = path.slice(1) as 'profile' | 'edit';
    return await renderPage(page, store.toJSON() as any, labels);
  }

  if (path === '/api/events') {
    let sseController: ReadableStreamDefaultController;
    const body = new ReadableStream({
      start(controller) {
        sseController = controller;
        serverTransport.addClient(controller);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        serverTransport.removeClient(sseController);
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (path === '/api/profile' && req.method === 'GET') {
    return new Response(JSON.stringify(store.toJSON()), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/api/profile' && req.method === 'POST') {
    const op = await req.json();
    serverTransport.receive(op);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (
    path.startsWith('/src/') ||
    path.startsWith('/css/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/rdf/')
  ) {
    const resp = await serveStatic(path);
    if (resp) return resp;
  }

  return new Response('Not Found', { status: 404 });
});

console.log('Profile POC running at http://localhost:8000');
