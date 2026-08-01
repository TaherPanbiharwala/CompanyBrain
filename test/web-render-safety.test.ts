// The UI must never hand attacker-influenced text to the DOM as MARKUP.
//
// Why this is the highest-stakes rule in the web layer, stated once so nobody has to reconstruct it:
//
//   * Uploaded documents become chunks; `ask` retrieves them; the model quotes them back. So answer
//     text and source text are attacker-influenced twice over — directly (the document) and
//     indirectly (prompt injection, which src/answer/prompt.ts exists to fight and cannot win
//     outright).
//   * Auth is a session cookie, and there is deliberately NO CSRF token — csrf.ts is an
//     origin-signal guard by design. So any script executing on this origin inherits full authority.
//   * That authority includes create_invite (mints a membership in this workspace), delete_page and
//     replace_page.
//
// Stored XSS here is therefore workspace takeover, not defacement. The CSP in src/web.ts is the
// backstop; NOT BUILDING THE HOLE is the control, and this test is what keeps it not-built.
//
// A source scan rather than a render test, deliberately. There is no DOM test runner in this repo,
// and adding one to assert "React escaped a string" would be testing React. The failure mode that
// actually ships is a developer reaching for dangerouslySetInnerHTML to render markdown — which is
// a decision visible in the source, at the moment it is made.
//
// Offline, no DOM, no database.
import { describe, it, expect } from 'bun:test';

const WEB_SRC = new URL('../web/src/', import.meta.url);

async function webFiles(): Promise<{ path: string; code: string }[]> {
  // {ts,tsx} only meant a component authored as .jsx or .js was invisible to this scan — and nothing
  // in the toolchain forbids one: Vite compiles .jsx out of the box and web/tsconfig.json sets
  // allowJs off but never blocks the file from being bundled. A single .jsx file with
  // dangerouslySetInnerHTML would have shipped past a green suite.
  const glob = new Bun.Glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}');
  const out: { path: string; code: string }[] = [];
  for await (const rel of glob.scan({ cwd: WEB_SRC.pathname })) {
    const src = await Bun.file(new URL(rel, WEB_SRC)).text();
    // Strip comments so the prose in THIS file's own explanations — and any future comment that
    // names the API in order to warn about it — cannot trip the scan. The check is about code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    out.push({ path: rel, code });
  }
  return out;
}

/** Every shape that puts a raw string into the DOM as markup.
 *
 *  Two proven bypasses closed here, both demonstrated by planting a file and watching the suite stay
 *  green: `innerHTML\s*=` does not match `innerHTML += x`, and `outerHTML` / `setHTMLUnsafe` were
 *  absent entirely. The `+?` covers the append form; setHTMLUnsafe is the modern one that will start
 *  appearing in copy-pasted code. */
const SINK_RE = /dangerouslySetInnerHTML|(?:inner|outer)HTML\s*\+?=|insertAdjacentHTML|setHTMLUnsafe\s*\(|document\.write/;

describe('web render safety', () => {
  it('no component injects raw HTML', async () => {
    const files = await webFiles();
    const offenders = files
      .filter((f) => SINK_RE.test(f.code))
      .map((f) => f.path);
    expect(
      offenders,
      `these files inject raw HTML: ${offenders.join(', ')}. Answer text and page content are ` +
        `model output derived from uploaded documents, on a cookie-authenticated origin with no ` +
        `CSRF token — script here can call create_invite. Render as text, or sanitize explicitly ` +
        `and say why in a comment.`,
    ).toEqual([]);
  });

  it('no eval-shaped execution of dynamic strings', async () => {
    const files = await webFiles();
    const offenders = files
      .filter((f) => /\beval\s*\(|new\s+Function\s*\(/.test(f.code))
      .map((f) => f.path);
    expect(offenders, `eval-shaped code in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the scan actually sees the web sources — anti-vacuity', async () => {
    // Without this, deleting web/src or renaming the directory makes every assertion above pass by
    // inspecting nothing. This repo has shipped that exact vacuity more than once (D50, D62, D64),
    // which is why every source scan here carries a floor.
    const files = await webFiles();
    // Counted floors absorb losses silently: at 8 against the 12 files that match today, four could
    // be deleted or renamed out of the glob before this said a word — and the four that render
    // attacker-influenced text are exactly the ones worth losing sleep over. Name them instead; a
    // filename survives a content change, and the scan going blind on AnswerView specifically is the
    // failure that matters.
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const required of [
      'components/AnswerView.tsx',
      'components/PageList.tsx',
      'components/Upload.tsx',
      'components/ErrorPanel.tsx',
      'screens/Home.tsx',
    ]) {
      const f = files.find((x) => x.path === required);
      expect(f, `${required} is not being scanned — a raw-HTML sink there would ship past this suite`).toBeDefined();
      expect(f!.code.length, `${required} scanned as empty`).toBeGreaterThan(200);
    }
    // And it must be reading real component source, not empty files.
    expect(files.some((f) => f.path.endsWith('.tsx') && f.code.includes('return ('))).toBe(true);
  });

  it('the API client stays DOM-free, because the server test project compiles it', async () => {
    // test/answer-confidence.test.ts imports web/src/lib/api.ts, which pulls that file into the
    // ROOT tsconfig — whose lib is ["ESNext"] with no DOM. That is a useful constraint (the API
    // client should not need a document) but a surprising one to hit blind, so it is named here:
    // if you add `document`/`window`/`localStorage` to api.ts, `bun run typecheck` fails on the
    // SERVER project, which reads like an unrelated error.
    const code = await Bun.file(new URL('lib/api.ts', WEB_SRC)).text();
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    expect(/\b(document|window|localStorage|sessionStorage)\s*\./.test(stripped)).toBe(false);
  });
});

describe('URL sinks', () => {
  // The scan above covers raw-HTML sinks and nothing else — yet the sink class that required a fix
  // in this very diff was a URL: ErrorPanel gained safeDocsHref because a server-supplied string was
  // flowing into an href. A future `<a href={hit.docsUrl}>` or `<img src={page.thumbnail}>` built
  // from document- or model-derived text passes the raw-HTML scan unchanged, and a javascript: href
  // on this origin is workspace takeover for exactly the reasons that file's header enumerates.
  // Accepted without complaint: a validator call, or a literal that BEGINS with '/' — a same-origin
  // path. Interpolation inside such a template is fine because the scheme and origin are already
  // fixed by the leading slash; `/auth/google?return_to=${x}` cannot become javascript:.
  const SAFE_EXPR = /^safeDocsHref\(|^[`'"]\//;
  /** Identifiers vetted by reading them. Each must be a template literal starting with '/', pinned
   *  by the assertion below so a rename or redefinition cannot quietly widen this list. */
  const VETTED_IDENTS: Record<string, string> = {
    'screens/SignIn.tsx': 'googleHref',
    'components/ErrorPanel.tsx': 'docsHref',
  };
  /** How each vetted identifier must be DEFINED. The exemption is only sound because of this. */
  const VETTED_DEFN: Record<string, RegExp> = {
    googleHref: /const googleHref = `\//,
    docsHref: /const docsHref = safeDocsHref\(/,
  };

  it('no dynamic URL attribute reaches the DOM without a validator', async () => {
    const files = await webFiles();
    expect(files.length, 'nothing scanned').toBeGreaterThanOrEqual(12);
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of f.code.matchAll(/(href|src|action|formAction)=\{([^}]*)\}/g)) {
        const expr = (m[2] ?? '').trim();
        if (SAFE_EXPR.test(expr)) continue;
        if (VETTED_IDENTS[f.path] === expr) continue;
        offenders.push(`${f.path}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      `unvalidated URL attributes: ${offenders.join(', ')}. A javascript: href on this origin can ` +
        `call create_invite — route the value through safeDocsHref or use a literal path.`,
    ).toEqual([]);

    // The vetted identifiers are only safe because of how they are DEFINED. Pin that, or the
    // exemption above becomes a hole the moment one is reassigned from a server-supplied string.
    for (const [path, ident] of Object.entries(VETTED_IDENTS)) {
      const f = files.find((x) => x.path === path);
      expect(f, `${path} is vetted but no longer scanned`).toBeDefined();
      expect(
        f!.code,
        `${ident} in ${path} is exempt from the URL scan but is no longer defined safely`,
      ).toMatch(VETTED_DEFN[ident]!);
    }
  });

  it('safeDocsHref does not accept an arbitrary third-party https origin', async () => {
    // An allow-list, not a scheme check. Blocking javascript: while accepting every https origin
    // still hands an attacker a chosen destination rendered inside the trusted app shell.
    const src = await Bun.file(new URL('../web/src/components/ErrorPanel.tsx', import.meta.url)).text();
    expect(src.indexOf('function safeDocsHref'), 'safeDocsHref is gone — this scan reads nothing').toBeGreaterThan(-1);
    expect(src, 'any https origin is accepted again').not.toMatch(/u\.protocol === 'https:'\s*\|\|/);
    expect(src).toContain('DOCS_HOSTS');
  });
});
