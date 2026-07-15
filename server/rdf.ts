import { DataFactory, Parser, Store, Writer } from 'n3';
import {
  TermWrapper,
  RequiredFrom,
  RequiredAs,
  SetFrom,
  LiteralAs,
  LiteralFrom,
  TermAs,
} from '@rdfjs/wrapper';

/** The schema.org namespace URI. */
export const SCHEMA = 'https://schema.org/';

/** The rdfs:label predicate URI. */
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const { namedNode } = DataFactory;

/**
 * Typed RDF wrapper providing getter/setter access to schema.org Person
 * properties backed by an N3 store. Scalar properties use `@rdfjs/wrapper`
 * helpers; `address` is manually resolved as a nested PostalAddress blank node.
 */
export class ProfilePerson extends TermWrapper {
  get name(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'name', LiteralAs.string);
  }
  set name(v: string) {
    RequiredAs.object(this, SCHEMA + 'name', v, LiteralFrom.string);
  }

  get jobTitle(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'jobTitle', LiteralAs.string);
  }
  set jobTitle(v: string) {
    RequiredAs.object(this, SCHEMA + 'jobTitle', v, LiteralFrom.string);
  }

  get email(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'email', LiteralAs.string);
  }
  set email(v: string) {
    RequiredAs.object(this, SCHEMA + 'email', v, LiteralFrom.string);
  }

  get description(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'description', LiteralAs.string);
  }
  set description(v: string) {
    RequiredAs.object(this, SCHEMA + 'description', v, LiteralFrom.string);
  }

  get url(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'url', LiteralAs.string);
  }
  set url(v: string) {
    RequiredAs.object(this, SCHEMA + 'url', v, LiteralFrom.string);
  }

  get image(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'image', LiteralAs.string);
  }
  set image(v: string) {
    RequiredAs.object(this, SCHEMA + 'image', v, LiteralFrom.string);
  }

  get isActive(): boolean {
    return RequiredFrom.subjectPredicate(this, SCHEMA + 'isActive', LiteralAs.boolean);
  }
  set isActive(v: boolean) {
    RequiredAs.object(this, SCHEMA + 'isActive', v, LiteralFrom.boolean);
  }

  get knowsLanguage(): Set<string> {
    return SetFrom.subjectPredicate(this, SCHEMA + 'knowsLanguage', LiteralAs.string, LiteralFrom.string);
  }

  get hasSkill(): string[] {
    return RequiredFrom.subjectPredicate(
      this,
      SCHEMA + 'hasSkill',
      TermAs.list(this, SCHEMA + 'hasSkill', LiteralAs.string, LiteralFrom.string),
    );
  }

  get address(): { streetAddress: string; addressLocality: string; addressCountry: string } | null {
    const store = this._dataset as Store;
    const quads = store.getQuads(this._term, namedNode(SCHEMA + 'address'), null, null);
    if (!quads.length) return null;
    const addrNode = quads[0].object;
    const get = (prop: string) => {
      const q = store.getQuads(addrNode, namedNode(SCHEMA + prop), null, null);
      return q.length ? q[0].object.value : '';
    };
    return {
      streetAddress: get('streetAddress'),
      addressLocality: get('addressLocality'),
      addressCountry: get('addressCountry'),
    };
  }

  set address(val: { streetAddress: string; addressLocality: string; addressCountry: string }) {
    const store = this._dataset as Store;
    const quads = store.getQuads(this._term, namedNode(SCHEMA + 'address'), null, null);
    let addrNode: any;
    if (quads.length) {
      addrNode = quads[0].object;
      for (const prop of ['streetAddress', 'addressLocality', 'addressCountry']) {
        store.removeQuads(store.getQuads(addrNode, namedNode(SCHEMA + prop), null, null));
      }
    } else {
      addrNode = namedNode('#address');
      store.addQuad(this._term, namedNode(SCHEMA + 'address'), addrNode);
      store.addQuad(addrNode, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(SCHEMA + 'PostalAddress'));
    }
    for (const [prop, v] of Object.entries(val)) {
      store.addQuad(addrNode, namedNode(SCHEMA + prop), DataFactory.literal(v));
    }
  }
}

/** Multilingual label map: subject URI → (language code → display text). */
export type Labels = Map<string, Map<string, string>>;

/** Parse a Turtle string into an N3 Store. */
export function parseTurtle(text: string): Store {
  const store = new Store();
  const parser = new Parser({ format: 'Turtle' });
  store.addQuads(parser.parse(text));
  return store;
}

/** Find the `#me` subject in the store and return a typed ProfilePerson wrapper. */
export function getProfile(store: Store): ProfilePerson {
  const me = store.getSubjects(null, null, null).find((s: any) => s.value.endsWith('#me'));
  if (!me) throw new Error('No #me subject found in profile Turtle');
  return new ProfilePerson(me, store, DataFactory);
}

/** Extract all profile fields into a plain state object for the store. */
export function toState(person: ProfilePerson): Record<string, unknown> {
  return {
    name: person.name,
    jobTitle: person.jobTitle,
    email: person.email,
    description: person.description,
    url: person.url,
    image: person.image,
    isActive: person.isActive,
    knowsLanguage: [...person.knowsLanguage],
    hasSkill: [...person.hasSkill],
    address: person.address,
  };
}

/** Write a single property from a state change back into the RDF-backed ProfilePerson. */
export function updateFromState(person: ProfilePerson, prop: string, value: unknown): void {
  switch (prop) {
    case 'name':
    case 'jobTitle':
    case 'email':
    case 'description':
    case 'url':
    case 'image':
      (person as any)[prop] = value as string;
      break;
    case 'isActive':
      person.isActive = value as boolean;
      break;
    case 'knowsLanguage': {
      const langs = person.knowsLanguage;
      langs.clear();
      for (const l of value as string[]) langs.add(l);
      break;
    }
    case 'hasSkill': {
      const skills = person.hasSkill;
      while (skills.length > 0) skills.pop();
      skills.unshift(...(value as string[]));
      break;
    }
    case 'address':
      person.address = value as { streetAddress: string; addressLocality: string; addressCountry: string };
      break;
  }
}

/** Serialize an N3 Store back to Turtle text with schema.org prefixes. */
export function serializeTurtle(store: Store): string {
  const writer = new Writer({
    prefixes: {
      schema: SCHEMA,
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      '': '#',
    },
  });
  writer.addQuads(store.getQuads(null, null, null, null));
  let result = '';
  writer.end((_error: Error | null, output: string) => { result = output; });
  return result;
}

/** Extract rdfs:label quads from a store into a multilingual Labels map. */
export function loadLabels(store: Store): Labels {
  const labels: Labels = new Map();
  const quads = store.getQuads(null, namedNode(RDFS_LABEL), null, null);

  for (const quad of quads) {
    const subject = quad.subject.value;
    const lang = quad.object.language;
    const text = quad.object.value;

    if (!lang) continue;

    let langMap = labels.get(subject);
    if (!langMap) {
      langMap = new Map();
      labels.set(subject, langMap);
    }
    langMap.set(lang, text);
  }

  return labels;
}
