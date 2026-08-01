// Extracted from AnswerView, where it was exported out of the middle of another component. PageList
// then carried a load-bearing import edge on a sibling purely to reach a badge — which is how a
// components/ directory acquires a dependency graph nobody drew. It is a shared presentational
// primitive; it gets a file.
/**
 * Who else can see this source.
 *
 * The product's promise is permission-scoped answers, and until now the UI could not say who a cited
 * document was visible to — `search` returned no scope at all. Showing it answers "is this safe to
 * forward?" at the moment the question is actually being asked.
 */
export function ScopeBadge({ scope }: { scope: string }) {
  // EXHAUSTIVE, and unknown fails CLOSED. `scope === 'private' ? 'Only me' : 'Everyone'` rendered
  // "Everyone" for every value that was not exactly 'private' — including the empty string and any
  // scope added later. The team-scope spec vendored on this branch declares 'team', so the moment it
  // lands a team-only source would be labelled "Everyone at {Workspace}". This badge's whole job is
  // to answer "is this safe to forward?", and a fail-open default gives the permissive answer.
  const known = scope === 'private' || scope === 'workspace';
  const isPrivate = scope === 'private' || !known;
  return (
    <span
      className={
        isPrivate
          ? 'rounded-sm bg-surface-sunk px-1.5 py-0.5 font-medium text-ink-muted'
          : 'rounded-sm bg-brand-faint px-1.5 py-0.5 font-medium text-brand'
      }
    >
      {!known ? scope : isPrivate ? 'Only me' : 'Everyone'}
    </span>
  );
}
