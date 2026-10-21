import { Mark } from '@/components/Logo';
import { Button } from '@/components/ui';
import { checkAuthorize } from '@/lib/oauth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Where Claude sends the owner to connect it to the brain (lib/oauth.ts).
 * Behind the login like every page, so getting here takes the password and the
 * code; this page only asks whether to let the app in. The answer goes to
 * /api/oauth/authorize, which sends the browser back to Claude.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') params.set(k, v);
  const checked = await checkAuthorize(params);
  if ('redirect' in checked) redirect(checked.redirect);

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <Mark size={52} />
          <h1 className="mt-4 text-display font-bold text-ink">Second Brain</h1>
        </div>
        {'fatal' in checked ? (
          <p role="alert" className="mt-6 text-center text-body text-danger">
            {checked.fatal}
          </p>
        ) : (
          <form method="post" action="/api/oauth/authorize" className="mt-6 space-y-4">
            <p className="text-body text-ink">
              <strong>{checked.ok.client.name}</strong> wants to use your brain.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-body text-muted">
              <li>It can list your brains, search them and read their pages.</li>
              <li>It can send documents in to be filed, as an upload does. Each filing can be undone.</li>
              <li>It cannot edit or delete pages itself.</li>
              <li>You can end it any time on the Security page; signing out everywhere ends it too.</li>
            </ul>
            <p className="text-ui text-muted">
              It will be sent back to <span className="break-all text-ink">{new URL(checked.ok.redirectUri).host}</span>.
            </p>
            {['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state'].map((name) =>
              params.has(name) ? <input key={name} type="hidden" name={name} value={params.get(name)} /> : null,
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="submit" name="decision" value="deny" variant="quiet">
                Cancel
              </Button>
              <Button type="submit" name="decision" value="allow">
                Allow
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
