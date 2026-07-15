import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { renderPage, renderPeoplePage } from './server/template.ts';
import { ServerSSETransport } from './server/transport.ts';
import {
  initStore,
  parseTurtle,
  getProfileByIRI,
  listPeople,
  toState,
  updateFromState,
  serializeProfile,
  loadLabels,
  reloadProfile,
  validatePerson,
  type Labels,
  type ProfilePerson,
} from './server/rdf.ts';

const PROFILES_DIR = 'rdf/profiles';
const UI_PATH = 'rdf/ui.ttl';

const dataset = await initStore();
let labels: Labels = loadLabels(dataset);

function personIRI(id: string): string {
  return `http://localhost:8000/people/${id}#me`;
}

const PEOPLE_SUMMARY_PROPS = new Set(['name', 'jobTitle', 'image', 'isActive']);

const peopleTransport = new ServerSSETransport();
const peopleStore = new CPXStoreCore(
  { people: listPeople(dataset) },
  collabPlugin({ transport: peopleTransport }),
);

function syncPeopleStore() {
  const updated = listPeople(dataset);
  peopleTransport.receive({
    id: crypto.randomUUID(),
    origin: 'server',
    timestamp: Date.now(),
    prop: 'people',
    type: 'set',
    value: updated,
  });
}

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

interface ProfileSession {
  person: ProfilePerson;
  transport: ServerSSETransport;
  store: CPXStoreCore;
  lastSelfWrite: number;
  fileReloading: boolean;
}

const sessions = new Map<string, ProfileSession>();

function getSession(id: string): ProfileSession {
  let session = sessions.get(id);
  if (session) return session;

  const iri = personIRI(id);
  const person = getProfileByIRI(dataset, iri);
  const transport = new ServerSSETransport();
  const store = new CPXStoreCore(
    toState(person),
    collabPlugin({ transport }),
  );

  session = { person, transport, store, lastSelfWrite: 0, fileReloading: false };

  store.onChange((changes) => {
    if (session!.fileReloading) return;
    for (const [prop, { val }] of changes) {
      updateFromState(person, prop, val);
    }
    session!.lastSelfWrite = Date.now();
    serializeProfile(dataset, id).then(
      (turtle) => Deno.writeTextFile(`${PROFILES_DIR}/${id}.ttl`, turtle),
    );
    for (const [prop] of changes) {
      if (PEOPLE_SUMMARY_PROPS.has(prop)) {
        syncPeopleStore();
        break;
      }
    }
  });

  sessions.set(id, session);
  return session;
}

let labelsDebounce: number | undefined;
const profileDebounces = new Map<string, number>();

(async () => {
  const watcher = Deno.watchFs([PROFILES_DIR, 'rdf']);
  for await (const event of watcher) {
    if (event.kind !== 'modify' && event.kind !== 'create' && event.kind !== 'rename') continue;

    if (event.paths.some((p) => p.endsWith('ui.ttl'))) {
      clearTimeout(labelsDebounce);
      labelsDebounce = setTimeout(async () => {
        try {
          const newUiDataset = await parseTurtle(await Deno.readTextFile(UI_PATH));
          labels = loadLabels(newUiDataset);
          for (const session of sessions.values()) {
            session.transport.broadcastEvent('labels', serializeLabels(labels));
          }
          peopleTransport.broadcastEvent('labels', serializeLabels(labels));
          console.log('Labels reloaded and broadcast from', UI_PATH);
        } catch (e) {
          console.error('Failed to reload labels:', e);
        }
      }, 100);
    }

    for (const p of event.paths) {
      const match = p.match(/profiles\/([^/]+)\.ttl$/);
      if (!match) continue;
      const id = match[1];
      const session = sessions.get(id);
      if (session && Date.now() - session.lastSelfWrite < 1000) continue;

      clearTimeout(profileDebounces.get(id));
      profileDebounces.set(id, setTimeout(async () => {
        try {
          await reloadProfile(dataset, id);
          const session = sessions.get(id);
          if (!session) return;

          const newPerson = getProfileByIRI(dataset, personIRI(id));
          const newState = toState(newPerson);
          const oldState = session.store.toJSON() as Record<string, unknown>;
          const changed: [string, unknown][] = [];
          for (const [key, val] of Object.entries(newState)) {
            if (JSON.stringify(val) !== JSON.stringify(oldState[key])) {
              changed.push([key, val]);
            }
          }
          if (!changed.length) return;

          session.person = newPerson;
          session.fileReloading = true;
          for (const [key, val] of changed) {
            session.transport.receive({
              id: crypto.randomUUID(),
              origin: 'file',
              timestamp: Date.now(),
              prop: key,
              type: 'set',
              value: val,
            });
          }
          session.fileReloading = false;
          syncPeopleStore();
          console.log(`Profile reloaded and broadcast for ${id}`);
        } catch (e) {
          const s = sessions.get(id);
          if (s) s.fileReloading = false;
          console.error(`Failed to reload profile ${id}:`, e);
        }
      }, 100));
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
    return Response.redirect(new URL('/people', req.url), 302);
  }

  if (path === '/people') {
    const state = peopleStore.toJSON() as { people: any[] };
    return await renderPeoplePage(state.people, labels);
  }

  const profileMatch = path.match(/^\/(profile|edit)\/([a-z]+)$/);
  if (profileMatch) {
    const [, page, id] = profileMatch;
    const session = getSession(id);
    const resourceIRI = personIRI(id);
    const state = session.store.toJSON() as Record<string, unknown>;
    const validation = await validatePerson(dataset, resourceIRI);
    state.conforms = validation.conforms;
    state.validationErrors = validation.errors;
    return await renderPage(page as 'profile' | 'edit', state, labels, 'en', resourceIRI);
  }

  if (path === '/profile' || path === '/edit') {
    return Response.redirect(new URL('/people', req.url), 302);
  }

  if (path === '/api/events/people') {
    let sseController: ReadableStreamDefaultController;
    const body = new ReadableStream({
      start(controller) {
        sseController = controller;
        peopleTransport.addClient(controller);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        peopleTransport.removeClient(sseController);
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

  const eventsMatch = path.match(/^\/api\/events\/([a-z]+)$/);
  if (eventsMatch) {
    const id = eventsMatch[1];
    const session = getSession(id);
    let sseController: ReadableStreamDefaultController;
    const body = new ReadableStream({
      start(controller) {
        sseController = controller;
        session.transport.addClient(controller);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        session.transport.removeClient(sseController);
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

  const apiProfileMatch = path.match(/^\/api\/profile\/([a-z]+)$/);
  if (apiProfileMatch) {
    const id = apiProfileMatch[1];
    const session = getSession(id);

    if (req.method === 'GET') {
      return new Response(JSON.stringify(session.store.toJSON()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'POST') {
      const op = await req.json();
      session.transport.receive(op);
      const validation = await validatePerson(dataset, personIRI(id));
      return new Response(JSON.stringify({ ok: true, ...validation }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const validateMatch = path.match(/^\/api\/validate\/([a-z]+)$/);
  if (validateMatch) {
    const id = validateMatch[1];
    const iri = personIRI(id);
    const validation = await validatePerson(dataset, iri);
    return new Response(JSON.stringify(validation), {
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
