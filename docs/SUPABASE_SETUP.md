# Supabase Setup — 5 minutes, one-time

This is the only step that's a little fiddly, and it's only fiddly the first time. You're creating a free Supabase project that handles **sign-in** and **conversation storage** for your deployment. Without it, anyone with your URL could chat using your Anthropic key, which is exactly what we don't want.

If you've never used Supabase: it's a hosted database with auth built in. Free tier is generous (500MB database, ~50,000 active users/month). They take payment info but you don't get charged unless you blow past the free limits, which a personal chat tool almost certainly won't.

---

## Step 1: Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → click **Start your project** (or **Sign in** if you already have an account).
2. Sign up with GitHub (it's the fastest path).
3. On the dashboard, click **New project**.
4. Pick an **organization** (your personal one is fine).
5. Fill in:
   - **Name:** anything you want, e.g. `beginner-api-interface`
   - **Database Password:** Supabase generates a strong one — click **Generate** and let it set one. **Save it somewhere safe** (password manager). You won't need it for this app, but you'll want it if you ever poke at your database directly.
   - **Region:** pick whichever is geographically closest to you (faster).
   - **Pricing Plan:** **Free**.
6. Click **Create new project**.

Wait ~1 minute. Supabase is provisioning your database. You'll see a "Setting up project…" screen.

---

## Step 2: Run the schema

Once the project is ready, you'll land on the project dashboard.

1. In the left sidebar, find the **SQL Editor** icon (looks like `</>`).
2. Click **+ New query** (or there may already be an empty editor open).
3. Open the file [`docs/supabase-schema.sql`](supabase-schema.sql) from this repo. Copy its **entire contents**.
4. Paste it into the Supabase SQL Editor.
5. Click **Run** (bottom right, or `Cmd/Ctrl + Enter`).

You should see "Success. No rows returned" or similar. If you see any red errors, read them carefully — usually it's a copy-paste issue. The schema is safe to re-run; it uses `IF NOT EXISTS` everywhere.

That schema creates three tables (projects, conversations, files) and locks them down so each user can only see their own rows. Without that lock-down (Row-Level Security), one user could read another's conversations.

---

## Step 3: Grab the values you need

You need **two values** from your Supabase project to put into Vercel:

1. **Project URL**: in the left sidebar, click the gear icon (**Project Settings**) → **API**. Find **Project URL** — looks like `https://xxxxxxxxxxxxx.supabase.co`. **Use the copy button** next to it. (Manual highlight-and-copy can grab invisible characters from styled UI elements — we've been burned by this. Always click the copy icon.)
   - **Format matters:** the value must be *just* the project URL — scheme + host, nothing after `.supabase.co`. No trailing slash, no `/rest/v1` or other path. `https://xxxx.supabase.co` ✅ — `https://xxxx.supabase.co/` ❌ — `https://xxxx.supabase.co/rest/v1` ❌. A stray slash or path makes the auth endpoint resolve wrong and Supabase rejects sign-in with **"Invalid path specified in request URL"**. (`/api/config` now defensively normalizes this, but setting it cleanly is still the right fix.)
2. **anon / public key**: same page, look for the **anon / public** key — a long string starting with `eyJ`. **Use the copy button** here too.

> **A note on the keys:** the **anon key** is designed to be public (it's shipped to every browser that loads your app). Row-level security policies in the schema are what actually protect data, not key secrecy.

> **About the JWT Secret** you might see on the same page: this app **does not need it.** We verify auth tokens by asking Supabase's API directly, which works regardless of signing algorithm and means one less thing for you to copy correctly. You can ignore it.

---

## Step 4: Add the values to Vercel

If you've already deployed to Vercel:

1. Go to [vercel.com](https://vercel.com) → your project → **Settings → Environment Variables**.
2. Add these two:
   - **Name:** `SUPABASE_URL`     — **Value:** the Project URL from Step 3
   - **Name:** `SUPABASE_ANON_KEY` — **Value:** the anon key from Step 3
3. **For each value**: after pasting, click at the very end of the field and press Backspace once or twice to nuke any trailing invisible characters. Yes, really.
4. Make sure both are scoped to **Production** (and Preview if you want).
5. Go to **Deployments** → most recent → ⋯ → **Redeploy**.

If you're deploying for the first time, you'll add these on Vercel's "Configure Project" screen along with `ANTHROPIC_API_KEY` (3 environment variables total).

---

## Step 5: Configure the magic-link redirect (recommended)

When someone signs in, Supabase sends them an email with a magic link. That link sends them back to your app — but Supabase only allows redirects to URLs you've pre-approved.

1. Supabase dashboard → **Authentication** (left sidebar) → **URL Configuration**.
2. **Site URL:** set this to your Vercel deployment URL, e.g. `https://your-project.vercel.app`.
3. **Redirect URLs:** add both:
   - `https://your-project.vercel.app`
   - `https://your-project.vercel.app/*`
   - (And `http://localhost:3000` if you use `vercel dev` locally.)
4. Click **Save**.

Without this, magic-link emails will go out but clicking them will dump people on Supabase's default landing page instead of your app.

---

## Step 6 (required): sign in once, then lock down signups

This is the step that actually makes your deployment safe. Without it, **anyone** who finds your URL could enter their email, get a magic link, sign up, and start spending your Anthropic credits — the auth wall by itself only stops people who refuse to type an email address. Skip this step at your peril.

1. Open your deployed URL. You should see a sign-in screen.
2. Enter **your** email, hit **Send link**, check your inbox, click the link. You're now signed in. **You are now the only user that exists.**
3. Go back to Supabase → **Authentication** (left sidebar) → **Sign In / Providers** (or **Settings** depending on your UI).
4. Find the **Email** provider section.
5. Find the toggle labeled **Allow new users to sign up** (sometimes called "Enable signups"). Toggle it **OFF**.
6. Save.

Now nobody else can sign up. Magic-link sign-in still works for anyone whose email is already in your `auth.users` table — but right now that's just you.

> **If you want to add another person later** (say, a partner or collaborator): re-enable signups briefly, have them sign up, then turn it off again. Or: in Supabase → Authentication → Users, click **Invite user** and enter their email — they'll be added to the user table, and signups can stay off.

---

## Done

Each signed-in user gets their own private space — their projects, conversations, and files are visible only to them via row-level security. Open the app on your phone, sign in with the same email, and you'll see all the same conversations. That's the cross-device sync, free.

---

## Common gotchas

**"Setup needed" screen on the deployed app.** That means `/api/config` returned `configured: false` — probably one or both of `SUPABASE_URL` / `SUPABASE_ANON_KEY` is missing or named wrong in Vercel. Check Vercel → Settings → Environment Variables, then redeploy.

**Magic link email never arrives.** Check spam first. If still missing: Supabase → Authentication → Email templates — you can verify the email service is enabled. The free tier has rate limits (3 emails per hour by default for unauth users); usually fine for personal use.

**"Invalid path specified in request URL" when sending the magic link.** Your `SUPABASE_URL` has a trailing slash or a stray path (e.g. `…supabase.co/` or `…supabase.co/rest/v1`). Set it to just `https://xxxx.supabase.co` — scheme + host, nothing after `.supabase.co` — in Vercel, then redeploy. See the format note in Step 3.

**Magic link arrives but clicking it doesn't sign me in.** You probably skipped Step 5. The redirect URL has to be on Supabase's allow-list.

**"Authentication required" when sending a chat.** Either `SUPABASE_URL` / `SUPABASE_ANON_KEY` are missing in Vercel, or one of them has an invisible character from copy-paste. Re-copy using the **copy button** in Supabase (not text selection), Backspace any trailing whitespace after pasting, and redeploy.

**I want to start over with a fresh database.** Supabase dashboard → Project Settings → General → scroll to **Pause project** or **Delete project**. Or just drop the tables in SQL Editor: `DROP TABLE files; DROP TABLE conversations; DROP TABLE projects;` then re-run the schema.
