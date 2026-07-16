import { CPXStoreCore } from '@chapeaux/cpx-store/cpx-store-core';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { renderPage, renderPeoplePage, renderOrgsPage, renderOrgEditPage } from './server/template.ts';
import { ServerSSETransport } from './server/transport.ts';
import {
  initStore,
  getProfileByIRI,
  listPeople,
  toState,
  updateFromState,
  serializeProfile,
  loadLabels,
  reloadProfile,
  validatePerson,
  orgIRI,
  toOrgState,
  updateOrgFromState,
  listOrgs,
  serializeOrg,
  reloadOrg,
  createOrg,
  deleteOrg,
  type Labels,
  type ProfilePerson,
} from './server/rdf.ts';

const kv = await Deno.openKv();
const dataset = await initStore(kv);
let labels: Labels = loadLabels(dataset);
const channel = new BroadcastChannel('profile-sync');

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

const orgsTransport = new ServerSSETransport();
const orgsStore = new CPXStoreCore(
  { orgs: listOrgs(dataset) },
  collabPlugin({ transport: orgsTransport }),
);

function syncOrgsStore() {
  const updated = listOrgs(dataset);
  orgsTransport.receive({
    id: crypto.randomUUID(),
    origin: 'server',
    timestamp: Date.now(),
    prop: 'orgs',
    type: 'set',
    value: updated,
  });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
}

interface ProfileSession {
  person: ProfilePerson;
  transport: ServerSSETransport;
  store: CPXStoreCore;
  externalUpdate: boolean;
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

  session = { person, transport, store, externalUpdate: false };

  store.onChange((changes) => {
    if (session!.externalUpdate) return;
    for (const [prop, { val }] of changes) {
      updateFromState(person, prop, val);
    }
    serializeProfile(dataset, id).then((turtle) => {
      kv.set(['profiles', id], turtle);
      channel.postMessage({ type: 'profile-ops', id, turtle });
    });
    for (const [prop] of changes) {
      if (PEOPLE_SUMMARY_PROPS.has(prop)) {
        syncPeopleStore();
        break;
      }
    }
    for (const [prop] of changes) {
      if (prop === 'worksForId') {
        transport.receive({
          id: crypto.randomUUID(),
          origin: 'server',
          timestamp: Date.now(),
          prop: 'worksFor',
          type: 'set',
          value: toState(person).worksFor,
        });
        break;
      }
    }
  });

  sessions.set(id, session);
  return session;
}

interface OrgSession {
  transport: ServerSSETransport;
  store: CPXStoreCore;
  externalUpdate: boolean;
}

const orgSessions = new Map<string, OrgSession>();

function getOrgSession(id: string): OrgSession {
  let session = orgSessions.get(id);
  if (session) return session;

  const iri = orgIRI(id);
  const transport = new ServerSSETransport();
  const store = new CPXStoreCore(
    toOrgState(dataset, iri),
    collabPlugin({ transport }),
  );

  session = { transport, store, externalUpdate: false };

  store.onChange((changes) => {
    if (session!.externalUpdate) return;
    for (const [prop, { val }] of changes) {
      updateOrgFromState(dataset, iri, prop, val);
    }
    serializeOrg(dataset, id).then((turtle) => {
      kv.set(['orgs', id], turtle);
      channel.postMessage({ type: 'org-ops', id, turtle });
    });
    syncOrgsStore();
  });

  orgSessions.set(id, session);
  return session;
}

channel.onmessage = async (event: MessageEvent) => {
  const { type, id, turtle } = event.data;

  if (type === 'profile-ops') {
    await reloadProfile(dataset, id, turtle);
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
    session.externalUpdate = true;
    for (const [key, val] of changed) {
      session.transport.receive({
        id: crypto.randomUUID(),
        origin: 'broadcast',
        timestamp: Date.now(),
        prop: key,
        type: 'set',
        value: val,
      });
    }
    session.externalUpdate = false;
    syncPeopleStore();
    return;
  }

  if (type === 'org-ops') {
    await reloadOrg(dataset, id, turtle);
    const session = orgSessions.get(id);
    syncOrgsStore();
    if (!session) return;

    const iri = orgIRI(id);
    const newState = toOrgState(dataset, iri);
    const oldState = session.store.toJSON() as Record<string, unknown>;
    const changed: [string, unknown][] = [];
    for (const [key, val] of Object.entries(newState)) {
      if (JSON.stringify(val) !== JSON.stringify(oldState[key])) {
        changed.push([key, val]);
      }
    }
    if (!changed.length) return;

    session.externalUpdate = true;
    for (const [key, val] of changed) {
      session.transport.receive({
        id: crypto.randomUUID(),
        origin: 'broadcast',
        timestamp: Date.now(),
        prop: key,
        type: 'set',
        value: val,
      });
    }
    session.externalUpdate = false;
    return;
  }

  if (type === 'org-deleted') {
    deleteOrg(dataset, id);
    orgSessions.delete(id);
    syncOrgsStore();
    return;
  }
};

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

  if (path === '/orgs') {
    const state = orgsStore.toJSON() as { orgs: any[] };
    return await renderOrgsPage(state.orgs, labels);
  }

  const orgEditMatch = path.match(/^\/orgs\/edit\/([a-z0-9-]+)$/);
  if (orgEditMatch) {
    const id = orgEditMatch[1];
    const session = getOrgSession(id);
    const state = session.store.toJSON() as Record<string, unknown>;
    return await renderOrgEditPage(id, state, labels);
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

  if (path === '/api/events/orgs') {
    let sseController: ReadableStreamDefaultController;
    const body = new ReadableStream({
      start(controller) {
        sseController = controller;
        orgsTransport.addClient(controller);
        controller.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        orgsTransport.removeClient(sseController);
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

  const orgEventsMatch = path.match(/^\/api\/events\/org\/([a-z0-9-]+)$/);
  if (orgEventsMatch) {
    const id = orgEventsMatch[1];
    const session = getOrgSession(id);
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

  if (path === '/api/orgs' && req.method === 'POST') {
    const body = await req.json();
    const name = String(body.name ?? '').trim();
    if (!name) {
      return new Response(JSON.stringify({ error: 'Name required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const existing = new Set(listOrgs(dataset).map((o) => o.id));
    const base = slugify(name);
    let id = base;
    let suffix = 2;
    while (existing.has(id)) id = `${base}-${suffix++}`;

    createOrg(dataset, id, name);
    const turtle = await serializeOrg(dataset, id);
    await kv.set(['orgs', id], turtle);
    channel.postMessage({ type: 'org-ops', id, turtle });
    syncOrgsStore();

    return new Response(JSON.stringify({ id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiOrgMatch = path.match(/^\/api\/org\/([a-z0-9-]+)$/);
  if (apiOrgMatch) {
    const id = apiOrgMatch[1];

    if (req.method === 'DELETE') {
      deleteOrg(dataset, id);
      await kv.delete(['orgs', id]);
      orgSessions.delete(id);
      channel.postMessage({ type: 'org-deleted', id });
      syncOrgsStore();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = getOrgSession(id);

    if (req.method === 'GET') {
      return new Response(JSON.stringify(session.store.toJSON()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'POST') {
      const op = await req.json();
      session.transport.receive(op);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
