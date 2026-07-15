export class NamedNode {
    value;
    termType = 'NamedNode';
    constructor(value) {
        this.value = value;
    }
    equals(other) {
        return !!other && other.termType === 'NamedNode' && other.value === this.value;
    }
}
export class BlankNode {
    value;
    termType = 'BlankNode';
    constructor(value) {
        this.value = value;
    }
    equals(other) {
        return !!other && other.termType === 'BlankNode' && other.value === this.value;
    }
}
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const RDF_DIR_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString';
export class Literal {
    value;
    termType = 'Literal';
    language;
    direction;
    datatype;
    constructor(value, languageOrDatatype) {
        this.value = value;
        if (typeof languageOrDatatype === 'string' && languageOrDatatype !== '') {
            this.language = languageOrDatatype.toLowerCase();
            this.direction = '';
            this.datatype = new NamedNode(RDF_LANG_STRING);
        }
        else if (languageOrDatatype && typeof languageOrDatatype === 'object' && 'termType' in languageOrDatatype) {
            this.language = '';
            this.direction = '';
            this.datatype = languageOrDatatype;
        }
        else if (languageOrDatatype && typeof languageOrDatatype === 'object') {
            // DirectionalLanguage (RDF 1.2)
            this.language = languageOrDatatype.language.toLowerCase();
            this.direction = languageOrDatatype.direction ?? '';
            this.datatype = new NamedNode(this.direction === '' ? RDF_LANG_STRING : RDF_DIR_LANG_STRING);
        }
        else {
            this.language = '';
            this.direction = '';
            this.datatype = new NamedNode(XSD_STRING);
        }
    }
    equals(other) {
        return (!!other &&
            other.termType === 'Literal' &&
            other.value === this.value &&
            other.language === this.language &&
            (other.direction ?? '') === this.direction &&
            other.datatype.equals(this.datatype));
    }
}
export class Variable {
    value;
    termType = 'Variable';
    constructor(value) {
        this.value = value;
    }
    equals(other) {
        return !!other && other.termType === 'Variable' && other.value === this.value;
    }
}
export class DefaultGraph {
    termType = 'DefaultGraph';
    value = '';
    equals(other) {
        return !!other && other.termType === 'DefaultGraph';
    }
}
const DEFAULT_GRAPH = new DefaultGraph();
export class Quad {
    subject;
    predicate;
    object;
    graph;
    termType = 'Quad';
    value = '';
    constructor(subject, predicate, object, graph = DEFAULT_GRAPH) {
        this.subject = subject;
        this.predicate = predicate;
        this.object = object;
        this.graph = graph;
    }
    equals(other) {
        return (!!other &&
            other.termType === 'Quad' &&
            this.subject.equals(other.subject) &&
            this.predicate.equals(other.predicate) &&
            this.object.equals(other.object) &&
            this.graph.equals(other.graph));
    }
}
let blankNodeCounter = 0;
function fromTerm(original) {
    switch (original.termType) {
        case 'NamedNode':
            return new NamedNode(original.value);
        case 'BlankNode':
            return new BlankNode(original.value);
        case 'Literal':
            return new Literal(original.value, original.language !== ''
                ? { language: original.language, direction: original.direction ?? '' }
                : new NamedNode(original.datatype.value));
        case 'Variable':
            return new Variable(original.value);
        case 'DefaultGraph':
            return DEFAULT_GRAPH;
        case 'Quad':
            return fromQuad(original);
    }
}
function fromQuad(original) {
    return new Quad(fromTerm(original.subject), fromTerm(original.predicate), fromTerm(original.object), fromTerm(original.graph));
}
/** A spec-compliant RDF/JS DataFactory over the term classes above. */
export const DataFactory = {
    namedNode: (value) => new NamedNode(value),
    blankNode: (value) => new BlankNode(value ?? `b${++blankNodeCounter}`),
    literal: (value, languageOrDatatype) => new Literal(value, languageOrDatatype),
    variable: (value) => new Variable(value),
    defaultGraph: () => DEFAULT_GRAPH,
    quad: (subject, predicate, object, graph) => new Quad(subject, predicate, object, graph),
    fromTerm,
    fromQuad,
};
