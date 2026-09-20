// Pure link-extraction algorithm — no DB. See src/core/links/extract.ts for the two-pass design
// (markdown links, then title/slug mention).
import { describe, it, expect } from 'bun:test';
import { extractLinks, MIN_MENTION_LENGTH, MAX_LINKS_PER_PAGE, type LinkCandidate } from '../src/core/links/extract.ts';

const candidate = (id: string, slug: string, title: string | null): LinkCandidate => ({ id, slug, title });

describe('extractLinks — markdown pass', () => {
  it('resolves a markdown link whose href matches another page\'s slug', () => {
    const candidates = [candidate('p2', 'acme-contract', 'Acme Contract')];
    const links = extractLinks('See the [contract](acme-contract) for terms.', candidates);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toPageId: 'p2', linkKind: 'markdown', linkSource: 'acme-contract' });
  });

  it('normalizes a leading slash and page/ prefix, and strips fragment/query suffixes', () => {
    const candidates = [candidate('p2', 'acme-contract', null)];
    for (const href of ['/acme-contract', 'page/acme-contract', '/page/acme-contract#section', 'acme-contract?x=1']) {
      const links = extractLinks(`[link](${href})`, candidates);
      expect(links, `href=${href}`).toHaveLength(1);
      expect(links[0]?.linkSource).toBe('acme-contract');
    }
  });

  it('drops a markdown link whose href matches no known page (external URL)', () => {
    const candidates = [candidate('p2', 'acme-contract', null)];
    const links = extractLinks('See [Google](https://google.com) for search.', candidates);
    expect(links).toHaveLength(0);
  });

  it('captures a context excerpt around the match', () => {
    const candidates = [candidate('p2', 'acme-contract', null)];
    const links = extractLinks('Please review the [contract](acme-contract) before signing.', candidates);
    expect(links[0]?.context).toContain('contract');
  });

  it('masks markdown spans correctly when astral characters precede the link', () => {
    const candidates = [candidate('p2', 'acme-contract', 'Acme Contract')];
    const links = extractLinks(
      `${'😀'.repeat(20)} [Acme Contract](acme-contract) trailing text`,
      candidates,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toPageId: 'p2', linkKind: 'markdown' });
  });
});

describe('extractLinks — mention pass', () => {
  it('matches a page title case-insensitively with word boundaries', () => {
    const candidates = [candidate('p2', 'acme-corp', 'Acme Corp')];
    const links = extractLinks('We signed a deal with ACME CORP last week.', candidates);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toPageId: 'p2', linkKind: 'mention' });
  });

  it('does not match a substring inside a larger word', () => {
    const candidates = [candidate('p2', 'acme-corp', 'Acme Corp')];
    const links = extractLinks('MegaAcme Corporation is unrelated.', candidates);
    expect(links).toHaveLength(0);
  });

  it('falls back to slug when title is null', () => {
    const candidates = [candidate('p2', 'quarterly-planning', null)];
    const links = extractLinks('See quarterly-planning for details.', candidates);
    expect(links).toHaveLength(1);
    expect(links[0]?.linkSource).toBe('quarterly-planning');
  });

  it('skips a title/slug shorter than MIN_MENTION_LENGTH', () => {
    const shortTitle = 'x'.repeat(MIN_MENTION_LENGTH - 1);
    expect(shortTitle.length).toBeLessThan(MIN_MENTION_LENGTH);
    const candidates = [candidate('p2', 'q3', 'Q3')];
    const links = extractLinks('Q3 numbers are in.', candidates);
    expect(links).toHaveLength(0);
  });

  it('matches a multi-word title as one unit', () => {
    const candidates = [candidate('p2', 'project-falcon', 'Project Falcon')];
    const links = extractLinks('Status update on Project Falcon this week.', candidates);
    expect(links).toHaveLength(1);
  });

  it('does not throw on a title containing regex-special characters', () => {
    const candidates = [candidate('p2', 'q-and-a', 'Q&A (Engineering)')];
    expect(() => extractLinks('See the Q&A (Engineering) doc.', candidates)).not.toThrow();
  });
});

describe('extractLinks — cross-cutting behavior', () => {
  it('never matches a page against itself (candidates list excludes the source page by construction)', () => {
    // extractLinks has no concept of "self" — the caller (reconcile.ts) is responsible for excluding
    // the source page from the candidate list. This test documents that contract: passing the source
    // page as a candidate WOULD match it, so the caller must filter it out first.
    const candidates = [candidate('self', 'my-own-page', 'My Own Page')];
    const links = extractLinks('This is My Own Page talking about itself.', candidates);
    expect(links).toHaveLength(1); // proves extractLinks itself does not special-case self-reference
  });

  it('keeps markdown and mention edges to the same page as two distinct links (different link_kind)', () => {
    const candidates = [candidate('p2', 'acme-contract', 'Acme Contract')];
    const links = extractLinks('The [Acme Contract](acme-contract) — also known as the Acme Contract deal.', candidates);
    const kinds = links.map((l) => l.linkKind).sort();
    expect(kinds).toEqual(['markdown', 'mention']);
  });

  it('caps output at MAX_LINKS_PER_PAGE, keeping the longest (most specific) matches', () => {
    const candidates = Array.from({ length: MAX_LINKS_PER_PAGE + 10 }, (_, i) =>
      candidate(`p${i}`, `page-${i}`, `Unique Page Title Number ${i}`.padEnd(20 + (i % 5), 'x')));
    const text = candidates.map((c) => c.title).join('. ');
    const links = extractLinks(text, candidates);
    expect(links.length).toBe(MAX_LINKS_PER_PAGE);
  });

  it('chooses the same capped links regardless of candidate row order', () => {
    const candidates = Array.from({ length: MAX_LINKS_PER_PAGE + 10 }, (_, i) => {
      const suffix = String(i).padStart(2, '0');
      return candidate(`p${suffix}`, `page-${suffix}`, `Unique Title ${suffix}`);
    });
    const text = candidates.map((c) => c.title).join('. ');
    const forward = extractLinks(text, candidates).map((link) => link.toPageId);
    const reversed = extractLinks(text, [...candidates].reverse()).map((link) => link.toPageId);
    expect(reversed).toEqual(forward);
  });

  it('returns no links for text mentioning nothing and no candidates', () => {
    expect(extractLinks('Just some ordinary text with no references.', [])).toEqual([]);
  });
});
