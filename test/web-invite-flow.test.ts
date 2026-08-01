// Two bugs in the invite-accept screen that only walking the flow revealed, pinned so they cannot
// come back.
//
// Both were invisible to typecheck, to the build, and to 472 passing tests, because both are about
// WHEN an effect runs relative to state that arrives asynchronously. And both landed on the single
// screen where the credential is one-shot: an invite token is shown once, stored only as a hash,
// and consumed on first use. A UI mistake there is not a cosmetic bug, it burns the invite.
//
// A source scan, in this repo's established idiom (test/dispatch-limit.test.ts pins that apiLimiter
// left server.ts the same way). There is no DOM test runner here, and adding one to assert React
// effect ordering would be testing React. What actually ships is the ORDER of the guards, which is
// visible in the source.
//
// Offline: no DOM, no database, no server.
import { describe, it, expect } from 'bun:test';

const WEB = new URL('../web/src/', import.meta.url);

async function code(rel: string): Promise<string> {
  const src = await Bun.file(new URL(rel, WEB)).text();
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

describe('invite accept — signed-in state must be tri-state', () => {
  it('App passes null while the session is loading, never a bare boolean', async () => {
    const app = await code('App.tsx');
    // THE BUG: signedIn was `state === 'ready' || state === 'no-workspace'`, which is FALSE during
    // the very first render because the session starts as 'loading'. AcceptInvite acted on that
    // once and never revisited, so an already-signed-in user sat on "Sign in to accept" forever
    // holding a single-use token. Observed live, not theorised.
    expect(app).toMatch(/signedIn=\{[\s\S]{0,200}'loading'[\s\S]{0,60}\?\s*null/);
  });

  it('AcceptInvite declares signedIn as boolean | null and returns early on null', async () => {
    const c = await code('screens/AcceptInvite.tsx');
    expect(c).toMatch(/signedIn:\s*boolean\s*\|\s*null/);
    expect(c).toMatch(/if\s*\(\s*signedIn\s*===\s*null\s*\)\s*return/);
  });
});

describe('invite accept — guard ORDER, because success clears the token', () => {
  it('the already-accepting guard precedes the missing-token check', async () => {
    const c = await code('screens/AcceptInvite.tsx');
    const acceptingGuard = c.indexOf('if (accepting.current) return');
    const tokenRead = c.indexOf('sessionStorage.getItem(STASH_KEY)');
    const missingTokenError = c.indexOf('missing its token');

    expect(acceptingGuard).toBeGreaterThan(0);
    expect(missingTokenError).toBeGreaterThan(0);
    // THE BUG: the token check ran first. A successful accept deliberately REMOVES the stashed
    // token, so the re-render that success itself triggers found nothing and rendered "this invite
    // link is missing its token" on top of a membership that had just been granted. The user saw a
    // failure; the database saw a success.
    expect(acceptingGuard).toBeLessThan(tokenRead);
    expect(acceptingGuard).toBeLessThan(missingTokenError);
  });

  it('the not-signed-in path does NOT set the accepting guard', async () => {
    const c = await code('screens/AcceptInvite.tsx');
    // If it did, the guard would be set before the Google round trip and the accept could never
    // run when signedIn flipped true — trading one stuck screen for another.
    const notSignedIn = c.indexOf("if (!signedIn)");
    const setsGuard = c.indexOf('accepting.current = true');
    expect(notSignedIn).toBeGreaterThan(0);
    expect(setsGuard).toBeGreaterThan(notSignedIn);
  });

  it('the token is stashed in its own effect, so it survives a redirect', async () => {
    // This case used to assert only that two strings appeared SOMEWHERE in the file — never the
    // property it is named for. Measured: adding `if (signedIn === null) return;` to the top of the
    // stash effect and changing its deps from [] to [signedIn] — precisely the failure the component
    // comment says must not happen — left this file at 6 pass / 0 fail.
    const c = await code('screens/AcceptInvite.tsx');
    const stash = c.indexOf('sessionStorage.setItem(STASH_KEY');
    const sessionGuard = c.indexOf('if (signedIn === null) return');
    expect(stash, 'the stash call is gone — this scan reads nothing').toBeGreaterThan(-1);
    expect(sessionGuard, 'the tri-state session guard is gone').toBeGreaterThan(-1);

    // ORDER: the stash lives in the effect ABOVE the session-gated one. If a redirect fires while
    // the token is only in the address bar, it is gone for good and the invite is dead.
    expect(stash, 'the stash now sits after the session guard — a redirect will destroy the token')
      .toBeLessThan(sessionGuard);

    // EMPTY dep array. Any dependency re-runs it; a dependency on `signedIn` makes it wait for a
    // session that has not resolved on first paint.
    const closer = c.indexOf('}, [', stash);
    expect(closer, 'no dependency array found after the stash').toBeGreaterThan(-1);
    const deps = c.slice(closer, c.indexOf(')', closer) + 1);
    expect(deps.replace(/\s+/g, ''), `the stash effect depends on ${deps} — it must be []`).toBe('},[])');

    expect(c).toMatch(/history\.replaceState\(null, '', location\.pathname\)/);
  });

  it('the accept POST is fired by a CLICK, never by an effect', async () => {
    // Accepting sets active_workspace_id, so an effect-fired accept made merely OPENING a URL move a
    // signed-in user's active tenant — and their next upload with it. workspaces.ts names that exact
    // harm as the reason invites are token-only; the safeguard it describes is that the invitee
    // deliberately presents the token, which "clicked a link" is not. csrfGuard cannot help here:
    // the POST is same-origin, issued by our own page.
    const c = await code('screens/AcceptInvite.tsx');
    const call = c.indexOf("callAuth('/auth/invites/accept'");
    const acceptFn = c.indexOf('const accept = useCallback');
    expect(call, 'the accept call is gone — this scan is vacuous').toBeGreaterThan(-1);
    expect(acceptFn, 'the accept handler is gone').toBeGreaterThan(-1);
    expect(call, 'the accept POST moved back above the click handler — i.e. into an effect')
      .toBeGreaterThan(acceptFn);
    expect(c, 'nothing renders the confirm button').toMatch(/onClick=\{accept\}/);
    // The decision effect must stop at asking.
    expect(c).toMatch(/setStatus\('confirm'\)/);
  });

  it('an unintended accept is recoverable without signing out', async () => {
    // The membership cannot be un-granted from the UI, but the ACTIVE workspace is what actually
    // causes the harm. Nothing in web/ called the activate route before this, so recovery meant
    // signing out and hoping.
    const c = await code('screens/AcceptInvite.tsx');
    expect(c).toMatch(/\/auth\/workspaces\/\$\{currentWorkspace\.id\}\/activate/);
    expect(c, 'the switch-back affordance is not rendered').toMatch(/Switch back to/);
    const app = await code('App.tsx');
    expect(app, 'App no longer tells AcceptInvite which workspace it is replacing')
      .toMatch(/currentWorkspace=\{/);
  });
});

describe('routing — replaceState does not notify the router', () => {
  it('useRoute exposes navigate, and onAccepted uses it rather than raw replaceState', async () => {
    const app = await code('App.tsx');
    // THE BUG: onAccepted called history.replaceState('/') directly. popstate fires only for
    // back/forward, so the router never learned the path changed and kept the invite screen mounted
    // over a workspace the user had already joined. The URL said '/' and the screen said otherwise.
    // The signature now carries an explicit replace mode — replaceState was hardcoded, so every
    // future caller inherited "no history entry" silently.
    expect(app).toMatch(/function useRoute\(\):\s*\[string,\s*\(to: string, opts\?: \{ replace\?: boolean \}\) => void\]/);
    // And the invite hop must still REPLACE: the token is consumed, so Back must not return to it.
    expect(app).toMatch(/navigate\('\/', \{ replace: true \}\)/);
    // And the raw form must not come back in the accept handler.
    // ANCHOR FLOOR. indexOf returns -1 when the prop is renamed, and slice(-1, 299) yields '' —
    // so the negative assertion below passed against an empty string, i.e. against nothing. Assert
    // the anchor exists BEFORE slicing from it.
    const at = app.indexOf('onAccepted={');
    expect(at, "the 'onAccepted={' anchor is gone — this scan reads an empty string").toBeGreaterThan(-1);
    const onAccepted = app.slice(at, at + 300);
    expect(onAccepted.length).toBeGreaterThan(100);
    expect(onAccepted).not.toMatch(/history\.replaceState/);
  });
});
