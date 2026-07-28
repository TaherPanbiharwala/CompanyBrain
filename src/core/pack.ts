// The generic pack: what kinds of thing a company brain holds, and what is worth knowing about each.
//
// DATA, not code, and that is the whole design. gbrain's packs were a directory of YAML the operator
// could edit; this is one hard-coded pack in TypeScript because v0 has one vertical and a loader for
// a file nobody has written yet is a loader nobody has tested. The SHAPE is the part that has to be
// right now — swapping the source from this constant to a table is a small change, and swapping it
// from an implicit assumption scattered across four files is not.
//
// `kind` stays TEXT with no CHECK in the database. Migration 0004 records that decision explicitly:
// the list below is a CONVENTION so a new type needs no migration, not a closed taxonomy. Validation
// lives at the op boundary (an enum in the zod schema) where a bad value can be reported to the
// caller, rather than in a constraint that turns it into a 500.

export const PACK_KINDS = ['person', 'company', 'project', 'process', 'note'] as const;
export type PackKind = (typeof PACK_KINDS)[number];

/** What a page becomes when nothing says otherwise. `note` is the honest default: it claims nothing
 *  about structure, which is right for pasted text and for a file we have not classified. */
export const DEFAULT_PACK_KIND: PackKind = 'note';

export interface PackDefinition {
  kind: PackKind;
  /** One line, shown to an agent choosing a kind. Published in the `ingest` op's schema. */
  description: string;
  /**
   * The facts worth pulling out of a document of this kind.
   *
   * UNUSED TODAY, and marked so rather than quietly present. M7's compiled-truth synthesis reads
   * these; nothing else does. A field that is declared and unread is otherwise indistinguishable
   * from one that was forgotten — D43 records exactly that failure for CB_REQUIRE_LIVE_TESTS, and
   * migration 0004's comment records it for `pages.kind` itself.
   */
  attributes: readonly string[];
}

export const PACK: readonly PackDefinition[] = [
  {
    kind: 'person',
    description: 'A colleague, customer contact, or anyone the company keeps notes about.',
    attributes: ['role', 'team', 'reports_to', 'email', 'joined', 'focus'],
  },
  {
    kind: 'company',
    description: 'A customer, prospect, vendor, or competitor.',
    attributes: ['industry', 'segment', 'contract_value', 'renewal_date', 'owner', 'status'],
  },
  {
    kind: 'project',
    description: 'A named initiative with a status and an owner.',
    attributes: ['status', 'owner', 'started', 'target_date', 'depends_on'],
  },
  {
    kind: 'process',
    description: 'How something is done here — a runbook, policy, or standard operating procedure.',
    attributes: ['owner', 'trigger', 'steps', 'last_reviewed'],
  },
  {
    kind: 'note',
    description: 'Anything else: meeting notes, a document, a scratch page. The default.',
    attributes: ['date', 'attendees', 'source'],
  },
];

const byKind = new Map(PACK.map((p) => [p.kind, p]));

export function packFor(kind: string): PackDefinition | undefined {
  return byKind.get(kind as PackKind);
}

/**
 * The extraction prompt template, with a VOCABULARY SLOT.
 *
 * Not called by anything yet — M7 is where structured extraction lands. It lives here now for one
 * reason: the slot. A per-workspace vocabulary ("we call them 'pods', not 'teams'") is the feature
 * that makes this a company brain rather than a generic RAG, and retrofitting a slot into a prompt
 * that shipped without one means every stored extraction predates the vocabulary and has to be
 * redone. Reserving the shape costs nothing; discovering it costs a re-extraction of the corpus.
 */
export function buildExtractionPrompt(pack: PackDefinition, vocabulary: readonly string[] = []): string {
  const vocab = vocabulary.length
    ? `\n\nThis company uses these terms; prefer them over synonyms: ${vocabulary.join(', ')}.`
    : '';
  return (
    `Extract the following attributes of this ${pack.kind} from the document, as JSON. ` +
    `Attributes: ${pack.attributes.join(', ')}. ` +
    `Omit any attribute the document does not state — never infer or fill from general knowledge.${vocab}`
  );
}
