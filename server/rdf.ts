import { Dataset, DataFactory } from '@jeswr/sparq';
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

const { namedNode, literal, quad } = DataFactory;

/**
 * Typed RDF wrapper providing getter/setter access to schema.org Person
 * properties backed by a sparq Dataset. Scalar properties use `@rdfjs/wrapper`
 * helpers; `address` is manually resolved as a nested PostalAddress node.
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
    const ds = this._dataset as Dataset;
    const addrQuads = [...ds.match(this._term, namedNode(SCHEMA + 'address'))];
    if (!addrQuads.length) return null;
    const addrNode = addrQuads[0].object;
    const get = (prop: string) => {
      const q = [...ds.match(addrNode, namedNode(SCHEMA + prop))];
      return q.length ? q[0].object.value : '';
    };
    return {
      streetAddress: get('streetAddress'),
      addressLocality: get('addressLocality'),
      addressCountry: get('addressCountry'),
    };
  }

  set address(val: { streetAddress: string; addressLocality: string; addressCountry: string }) {
    const ds = this._dataset as Dataset;
    const addrQuads = [...ds.match(this._term, namedNode(SCHEMA + 'address'))];
    let addrNode: any;
    if (addrQuads.length) {
      addrNode = addrQuads[0].object;
      for (const prop of ['streetAddress', 'addressLocality', 'addressCountry']) {
        for (const q of [...ds.match(addrNode, namedNode(SCHEMA + prop))]) {
          ds.delete(q);
        }
      }
    } else {
      addrNode = namedNode('#address');
      ds.add(quad(this._term, namedNode(SCHEMA + 'address'), addrNode));
      ds.add(quad(addrNode, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(SCHEMA + 'PostalAddress')));
    }
    for (const [prop, v] of Object.entries(val)) {
      ds.add(quad(addrNode, namedNode(SCHEMA + prop), literal(v)));
    }
  }
}

/** Multilingual label map: subject URI → (language code → display text). */
export type Labels = Map<string, Map<string, string>>;

const PROFILES_DIR = 'rdf/profiles';
const UI_PATH = 'rdf/ui.ttl';
const ORG_PATH = 'rdf/org.ttl';

/** Parse a Turtle string into a sparq Dataset. */
export async function parseTurtle(text: string): Promise<Dataset> {
  return await Dataset.fromString(text, 'turtle');
}

/** Load all .ttl files from rdf/profiles/ and rdf/ui.ttl into a single Dataset. */
export async function initStore(): Promise<Dataset> {
  const dataset = await Dataset.create();
  for await (const entry of Deno.readDir(PROFILES_DIR)) {
    if (!entry.name.endsWith('.ttl')) continue;
    const text = await Deno.readTextFile(`${PROFILES_DIR}/${entry.name}`);
    const ds = await Dataset.fromString(text, 'turtle');
    for (const q of ds) dataset.add(q);
  }
  for (const path of [UI_PATH, ORG_PATH]) {
    try {
      const text = await Deno.readTextFile(path);
      const ds = await Dataset.fromString(text, 'turtle');
      for (const q of ds) dataset.add(q);
    } catch {
      // optional file
    }
  }
  return dataset;
}

/** Return a ProfilePerson wrapper for a given person IRI. */
export function getProfileByIRI(dataset: Dataset, personIRI: string): ProfilePerson {
  return new ProfilePerson(namedNode(personIRI), dataset, DataFactory);
}

/** Find the `#me` subject in the dataset and return a typed ProfilePerson wrapper. */
export function getProfile(dataset: Dataset): ProfilePerson {
  const subjects = new Set<string>();
  for (const q of dataset) {
    subjects.add(q.subject.value);
  }
  const meIRI = [...subjects].find((s) => s.endsWith('#me'));
  if (!meIRI) throw new Error('No #me subject found in profile Turtle');
  return new ProfilePerson(namedNode(meIRI), dataset, DataFactory);
}

/** List all person IDs and summary data from the dataset. */
export function listPeople(dataset: Dataset): { id: string; name: string; jobTitle: string; image: string; isActive: boolean }[] {
  const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const personType = namedNode(SCHEMA + 'Person');
  const people: { id: string; name: string; jobTitle: string; image: string; isActive: boolean }[] = [];

  for (const q of dataset.match(null, rdfType, personType)) {
    const personIRI = q.subject.value;
    const match = personIRI.match(/\/people\/([^/#]+)/);
    if (!match) continue;
    const id = match[1];
    const get = (prop: string) => {
      const quads = [...dataset.match(q.subject, namedNode(SCHEMA + prop))];
      return quads.length ? quads[0].object.value : '';
    };
    people.push({
      id,
      name: get('name'),
      jobTitle: get('jobTitle'),
      image: get('image'),
      isActive: get('isActive') !== 'false',
    });
  }
  return people;
}

/** Reload a profile file into the dataset, replacing all quads for that person's base IRI. */
export async function reloadProfile(dataset: Dataset, id: string): Promise<void> {
  const baseIRI = `http://localhost:8000/people/${id}`;
  for (const q of [...dataset]) {
    if (q.subject.value.startsWith(baseIRI)) dataset.delete(q);
    if (q.object.value.startsWith(baseIRI)) dataset.delete(q);
  }
  const text = await Deno.readTextFile(`${PROFILES_DIR}/${id}.ttl`);
  const ds = await Dataset.fromString(text, 'turtle');
  for (const q of ds) dataset.add(q);
}

/** Extract all profile fields into a plain state object for the store. */
export function toState(person: ProfilePerson): Record<string, unknown> {
  const ds = person._dataset as Dataset;
  const worksForQuads = [...ds.match(person._term, namedNode(SCHEMA + 'worksFor'))];
  let worksFor: Record<string, string> | null = null;
  if (worksForQuads.length) {
    const orgNode = worksForQuads[0].object;
    const getOrg = (prop: string) => {
      const q = [...ds.match(orgNode, namedNode(SCHEMA + prop))];
      return q.length ? q[0].object.value : '';
    };
    worksFor = {
      '@id': orgNode.value,
      name: getOrg('name'),
      url: getOrg('url'),
      description: getOrg('description'),
    };
  }

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
    worksFor,
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

/** Serialize a sparq Dataset to Turtle text with schema.org prefixes. */
export function serializeTurtle(dataset: Dataset): string {
  return dataset.store.serialize('turtle');
}

/** Serialize only the quads belonging to a specific profile (including reachable blank nodes). */
export async function serializeProfile(dataset: Dataset, id: string): Promise<string> {
  const baseIRI = `http://localhost:8000/people/${id}`;
  const profileDs = await Dataset.create();
  const visitedBlanks = new Set<string>();

  function addBlankNodeQuads(bnodeValue: string) {
    if (visitedBlanks.has(bnodeValue)) return;
    visitedBlanks.add(bnodeValue);
    for (const q of dataset) {
      if (q.subject.termType === 'BlankNode' && q.subject.value === bnodeValue) {
        profileDs.add(q);
        if (q.object.termType === 'BlankNode') {
          addBlankNodeQuads(q.object.value);
        }
      }
    }
  }

  for (const q of dataset) {
    if (q.subject.value.startsWith(baseIRI)) {
      profileDs.add(q);
      if (q.object.termType === 'BlankNode') {
        addBlankNodeQuads(q.object.value);
      }
    }
  }

  return profileDs.store.serialize('turtle');
}

const SHAPES_PATH = 'rdf/shapes/person.ttl';
let shapesText: string | null = null;

async function getShapesText(): Promise<string> {
  if (shapesText === null) {
    shapesText = await Deno.readTextFile(SHAPES_PATH);
  }
  return shapesText;
}

export interface ValidationResult {
  conforms: boolean;
  errors: Record<string, string[]>;
}

export async function validatePerson(dataset: Dataset, personIRI: string): Promise<ValidationResult> {
  const shapes = await getShapesText();
  const id = personIRI.match(/\/people\/([^/#]+)/)?.[1];
  if (!id) return { conforms: true, errors: {} };
  const dataTurtle = await serializeProfile(dataset, id);

  try {
    const report = dataset.store.validate(dataTurtle, shapes, 'turtle');
    const errors: Record<string, string[]> = {};

    if (report.results) {
      for (const r of report.results) {
        const path = r.resultPath ?? r.path ?? '';
        const prop = path.replace(SCHEMA, '');
        const msg = r.resultMessage ?? r.message ?? 'Validation failed';
        if (!errors[prop]) errors[prop] = [];
        errors[prop].push(msg);
      }
    }

    return { conforms: report.conforms ?? true, errors };
  } catch (e) {
    console.error('SHACL validation error:', e);
    return { conforms: true, errors: {} };
  }
}

/** Extract rdfs:label quads from a dataset into a multilingual Labels map. */
export function loadLabels(dataset: Dataset): Labels {
  const labels: Labels = new Map();
  const labelPred = namedNode(RDFS_LABEL);

  for (const q of dataset.match(null, labelPred)) {
    const subject = q.subject.value;
    const lang = (q.object as any).language;
    const text = q.object.value;

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
