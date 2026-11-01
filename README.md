# JobSearchAITool (JobApplyAI)

A free, local job-search assistant for **QA / SDET / software-testing roles in India (and remote roles open to
India)**. It finds jobs that fit your resume and experience level, fills in application forms for you, and
tracks every application on a calendar.

- **Finds jobs every morning** from 100+ company career boards and remote-job feeds.
- **Filters by your level:** drops senior/lead roles, jobs asking for more years than you have, and jobs outside
  India.
- **Scores each job** against your resume (0–100) and shows which skills match and which are missing.
- **Prefills applications in batches of 20 tabs.** Name, contact, resume upload, CTC, notice period, education and
  common screening questions are filled from your own facts. **You review each tab and press Submit yourself.**
- **Tracks applications** on a calendar: screening calls, assessments, interviews, offers, follow-ups.

**No AI is needed.** Everything works with built-in rules and runs on your computer. An optional Anthropic API key
adds AI-written answers (see [Optional: AI answers](#optional-ai-answers-anthropic)), but you don't need it.

Your resume, answers and application history never leave your computer. The tool only reads public job listings.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Install](#2-install)
3. [Add your resume](#3-add-your-resume)
4. [Fill in your answers (profile.yaml)](#4-fill-in-your-answers-profileyaml)
5. [Choose what to search for (search.yaml)](#5-choose-what-to-search-for-searchyaml)
6. [First run](#6-first-run)
7. [Daily use: the dashboard](#7-daily-use-the-dashboard)
8. [Run the search automatically every morning](#8-run-the-search-automatically-every-morning)
9. [All commands](#9-all-commands)
10. [How jobs are picked and scored](#10-how-jobs-are-picked-and-scored)
11. [What gets filled, and what is left to you](#11-what-gets-filled-and-what-is-left-to-you)
12. [Supported sites and limits](#12-supported-sites-and-limits)
13. [Troubleshooting](#13-troubleshooting)
14. [Adapting it to other roles or countries](#14-adapting-it-to-other-roles-or-countries)
15. [For developers](#15-for-developers)

---

## 1. What you need

| Requirement | Why | Get it |
|---|---|---|
| **Node.js 22.13 or newer** (24 recommended) | Runs the tool | <https://nodejs.org> (LTS installer) |
| **Google Chrome** (or Microsoft Edge) | The browser that fills forms | <https://www.google.com/chrome> |
| **Git** (optional) | To download and update the code | <https://git-scm.com/downloads> |
| **Your resume** as PDF or DOCX | Source of your skills and experience | |

Works on Windows, macOS and Linux. The one-click `.cmd` scripts are Windows-only; everything else is the same
everywhere.

To check Node is installed, open a terminal (PowerShell on Windows, Terminal on macOS) and run:

```bash
node --version
```

It should print `v22.13.0` or higher.

## 2. Install

```bash
git clone https://github.com/tejash-veer46/JobSearchAITool.git
cd JobSearchAITool
npm install
```

No Git? On the GitHub page, click **Code**, then **Download ZIP**. Unzip it, open a terminal in that folder, and
run `npm install`.

`npm install` takes a minute. It doesn't download a browser; the tool uses the Chrome you already have.

## 3. Add your resume

Put your resume (PDF or DOCX) in a folder named `resume` inside the project folder:

```
JobSearchAITool/
  resume/
    Your_Name_Resume.pdf
```

The newest file in that folder is used. Check what the tool read from it:

```bash
npm run cli -- profile
```

You should see your name, contact details, total years of experience, jobs, skills and education. If years of
experience look wrong, set `years_experience_override` in `profile.yaml` (next step).

**Tip:** the parser works best with a standard layout: section headings like SUMMARY, SKILLS, EXPERIENCE, PROJECTS,
EDUCATION, and dates like `May 2024 – Present`.

## 4. Fill in your answers (profile.yaml)

Application forms ask the same things again and again: notice period, expected CTC, current city, CGPA, "why are
you looking for a change?". You answer them **once** in `config/profile.yaml`, and every form reuses them.

1. Run any command once (for example `npm run cli -- profile`). This creates `config/profile.yaml` from
   `config/profile.example.yaml`.
2. Open `config/profile.yaml` in any text editor and fill in what you're comfortable sharing. Every field is
   explained in the file. The main ones:

| Field | Example | Used for |
|---|---|---|
| `contact.current_city` | `Bengaluru` | "Current location", "Are you based in X?" |
| `preferences.willing_to_relocate` | `true` | Relocation questions |
| `preferences.office_ok`, `shifts_ok` | `true` | "Comfortable working from office / in shifts?" |
| `compensation.expected_ctc_inr` | `1200000` | Expected CTC (yearly, in rupees) |
| `compensation.current_ctc_inr` | `800000` | Current CTC |
| `notice_period_days` | `60` | Notice period / "How soon can you join?" |
| `work_authorization` | `Indian citizen, no sponsorship required` | Work authorization / sponsorship |
| `education.*` | CGPA, Class 10/12 %, graduation year | Education questions common on Indian forms |
| `extra_skills` | `[Cypress, Linux]` | Skills you really have that your resume doesn't list |
| `gender`, `disability` | `Male`, `"No"` | Answered as given; leave `null` to decline where possible |
| `standard_answers.why_change` | 1–2 sentences | "Why are you looking for a change?" |
| `standard_answers.about_me` | 2–3 sentences | "Tell us about yourself" |

Anything left as `""` or `null` is **never guessed**. Forms that ask for it wait for your answer.

This file is listed in `.gitignore`, so it is never committed or shared.

## 5. Choose what to search for (search.yaml)

`config/search.yaml` is created from `config/search.example.yaml` on first run. Useful settings:

```yaml
filters:
  max_required_years: 3     # skip jobs asking for more years than this
  max_age_days: 30          # skip job-feed postings older than this
  include_manual_qa: true   # include manual-testing roles (scored lower)
  extra_title_keywords: []  # extra words that make a title relevant
  extra_title_excludes: []  # words that make a title irrelevant

scoring:
  qualify_threshold: 75     # score needed to be "ready to apply"

batch:
  size: 20                  # tabs prefilled per batch
  auto_start: true          # prefill a batch when the dashboard opens

blacklist_companies:        # never apply here, e.g. your current employer
  - Your Current Company
```

**Set `max_required_years`** to about your experience plus one. For example, with 2 years of experience, use 3.

**Adding companies:** the `sources` section lists 100+ companies with public job boards. To add one, open its
careers page and look at the address:

| Careers URL looks like | Add under | slug |
|---|---|---|
| `boards.greenhouse.io/acme` or `job-boards.greenhouse.io/acme` | `greenhouse:` | `acme` |
| `jobs.lever.co/acme` | `lever:` | `acme` |
| `jobs.ashbyhq.com/acme` | `ashby:` | `acme` |

```yaml
  greenhouse:
    - { slug: acme, name: Acme }
```

A wrong slug shows up as `board not found (check the slug)` in the run output.

## 6. First run

```bash
npm run cli -- run
```

This takes 1–3 minutes. It fetches thousands of postings, filters them, scores the rest, and writes a report to
`reports/report_<date>_<time>.md`. You'll see something like:

```
5463 new, 5418 filtered out, ...
Scoring 44 job(s) with keyword rules...
Done: 25 new job(s) ready to apply.
```

Open the report for:

- the jobs ready to apply, and the near misses
- action items, such as profile facts that are still missing
- the skills jobs ask for that your resume doesn't show

## 7. Daily use: the dashboard

Start it:

- **Windows:** double-click `start-dashboard.cmd`, or in PowerShell run `.\start-dashboard.cmd`
- **Any OS:** `npm run dashboard`

Three windows appear:

1. **A console window.** Keep it open; closing it stops the dashboard.
2. **The dashboard** at <http://127.0.0.1:4317>, in your normal browser. It is only reachable from your own
   computer.
3. **The assistant's Chrome window.** It uses a separate Chrome profile in `browser-profile/`, so your normal
   Chrome is never touched. It opens one tab per job and fills it in.

### Batch view: apply

1. Wait until the summary stops saying "Filling tabs…" (about a minute).
2. For each job:
   - Click **Go to tab** and check the form.
   - Fill anything listed under "Still needs".
   - Tick consent boxes yourself if you agree.
   - Press the website's own **Submit** button.

   The submission is detected automatically, and the job moves to Applied and onto the calendar. If a CAPTCHA
   appears, solve it in the tab; the assistant waits.
3. Click **Skip** for jobs you don't want. If a submission wasn't detected, click **Applied**.
4. **Open these yourself:** some job feeds (Himalayas, Remotive) block automated browsers. Click
   **Open N in my browser** to open them in your normal browser and apply there.
5. **Did you apply?** For jobs you opened yourself, or tabs closed before a submission was detected, one click
   records each: *Yes, I applied*, *No, keep for later* or *Not interested*.
6. Click **Prepare next 20** for more. A job you've applied to, skipped or still have open is never picked twice.
   If nothing can be prefilled, the page says so and explains why.

### Tracker view: follow up

- **At the top:** applied (total and this week), response rate, interviews, offers, and how many have waited
  3+ weeks.
- **Calendar:** a month view of every event.
- **Coming up:** your next interviews and follow-ups.
- **No reply for 3+ weeks:** your follow-up candidates.

Click an application to change its **stage**, or to **add to its timeline**: HR screening, assessment, interview,
offer, rejection, follow-up, note. **+ Add application** records jobs you applied to elsewhere (LinkedIn, Naukri,
referrals), so everything is in one place.

### Jobs view: browse

- **Ready to apply / Near misses / Applied / Rejected / All**, plus search.
- **Each job:** its score and reasons, matched and missing skills, the full description, and an editable cover
  note.
- **Near misses:** jobs that scored just below the bar, often because they ask for more experience. Use
  **Move to ready** to include one in the next batch anyway.
- **Not interested:** removes a job for good.
- **Fetch new jobs:** runs the search now instead of waiting for the next morning.

## 8. Run the search automatically every morning

**Windows.** Run this once in PowerShell, from the project folder:

```powershell
$dir = (Get-Location).Path
$a = New-ScheduledTaskAction -Execute "$dir\run-daily.cmd" -WorkingDirectory $dir
$t = New-ScheduledTaskTrigger -Daily -At 8:30am
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'JobApplyAI daily fetch' -Action $a -Trigger $t -Settings $s
```

- It runs at 8:30 AM. If your computer was off, it runs as soon as it's back on.
- It logs to `data/run.log`.
- To remove it: `Unregister-ScheduledTask -TaskName 'JobApplyAI daily fetch'`.

**macOS / Linux.** Run `crontab -e` and add this line (change the path to your project folder):

```
30 8 * * * cd /path/to/JobSearchAITool && npm run cli -- run >> data/run.log 2>&1
```

## 9. All commands

Run each as `npm run cli -- <command>`.

| Command | What it does |
|---|---|
| `run` | Fetch, filter, score, write a report. `--source lever ashby` limits sources; `--limit 20` caps scoring. |
| `dashboard` | Start the dashboard (`--no-batch` skips prefilling, `--no-open` doesn't open the browser). Shortcut: `npm run dashboard`. |
| `profile` | Show what was read from your resume (`--refresh` re-reads it). |
| `list` | Ready jobs, best first (`--status APPLIED REJECTED` for others). |
| `show <id>` | One job: score, reasons, skills, screening answers, description. |
| `preview <id>` | **Read-only:** what the assistant would put in each field of that job's form. Fills nothing. |
| `apply <id>` | Apply to one job from the terminal; `--dry-run` fills but never submits. |
| `mark <id> applied` | Record an application yourself (also `rejected`, `staged`). |
| `score --rescore` | Re-score every job (e.g. after editing `extra_skills` or adding an API key). |
| `refilter` | Re-apply `search.yaml` filters to jobs already stored. |
| `report` | Rebuild the report. |

## 10. How jobs are picked and scored

1. **Fetch** from these sources:
   - Greenhouse, Lever and Ashby company boards (their official public feeds)
   - Himalayas and Remotive (remote jobs)
   - Adzuna (India-wide listings, optional free key)
2. **Remove duplicates** by source ID, URL, and company + title + city.
3. **Filter**, saving the reason for every rejection:
   - The title must be a QA/testing role, without Senior / Lead / Staff / Manager / III in it.
   - The location must be in India, or remote and open to India.
   - The job must not ask for more than `max_required_years`.
   - The company must not be on your blacklist.
   - Job-feed postings must not be older than `max_age_days`.
4. **Score** from 0 to 100:
   - how many of the job's listed skills your resume (plus `extra_skills`) shows
   - automation roles score higher than manual-only roles
   - whether the experience asked for matches yours

   Jobs at or above `qualify_threshold` become **Ready to apply**. Jobs asking for more years than you have are
   never auto-readied; they appear under **Near misses**.

## 11. What gets filled, and what is left to you

**Filled from your resume and `profile.yaml`:**

- **Identity:** name, email, phone, LinkedIn, GitHub, portfolio, country, city, current company and title.
- **Your resume file**, uploaded.
- **Experience:** total years. Options are never rounded up, so 1.8 years picks "1.5", not "2".
- **Compensation and availability:** expected and current CTC, notice period, joining time, offers in hand.
- **Work arrangements:** relocation, office, shifts, work authorization, sponsorship.
- **Education:** CGPA, Class 10 and 12, graduation year, gaps.
- **Other:** languages, gender, disability, "how did you hear about us", "why the change", "tell us about
  yourself".
- **"Do you have experience with X?"** Yes, but only when your resume or `extra_skills` shows *every* skill named.

**Always left to you:**

- consent and terms checkboxes
- work authorization for other countries
- service bonds
- skills you don't have
- job-specific essays ("Why do you want to join us?")
- anything missing from `profile.yaml`

Tick **remember** next to an answer in the dashboard, and it's saved to `profile.yaml` for future forms.

## 12. Supported sites and limits

| Site | Support |
|---|---|
| **Greenhouse** | Fully prefilled. |
| **Lever** | Fully prefilled. Lever's submit button uses hCaptcha, which can be stubborn in an automated browser. If it won't go through, finish that one in your normal browser. |
| **Ashby** | Prefilled (the form loads a moment after the page). |
| **Company sites via Adzuna** | Best effort: the assistant follows the "Apply" link and fills what it recognises. |
| **Himalayas, Remotive** | Opened in your normal browser (they block automated browsers). |
| **Workday and similar** | Need an account per company; apply yourself. |
| **LinkedIn, Naukri, Indeed** | **Not automated, on purpose.** Their terms forbid automated tools, and accounts get restricted. Apply there by hand and log the applications in the Tracker. |

The tool never tries to get around CAPTCHAs or bot protection, and it **never submits an application for you**.

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| `start-dashboard.cmd is not recognized` (PowerShell) | Type `.\start-dashboard.cmd` (PowerShell needs the `.\`), or double-click the file. |
| "The assistant browser is already open in another JobApplyAI window" | A previous dashboard is still running. Close its console window. |
| `Browser "chrome" not found` | Install Chrome, or put `BROWSER_CHANNEL=msedge` in `.env` to use Microsoft Edge. |
| Batch says "No jobs left that can be prefilled" | Answer "Did you apply?" items (*No, keep for later* re-queues them), move near misses to ready, add companies, or wait for tomorrow's fetch. |
| A tab says "No application form on this page" | Click the page's Apply button in that tab, then **Rescan page** in the dashboard. |
| A field was filled wrongly | Fix it in the tab before submitting. To see what a form will get, run `npm run cli -- preview <id>`. |
| Years of experience wrong | Set `years_experience_override` in `profile.yaml`, then run `npm run cli -- profile --refresh`. |
| Too few jobs | Raise `max_required_years`, lower `qualify_threshold`, add companies, or add an Adzuna key. |
| Too many irrelevant jobs | Raise `qualify_threshold`, or add words to `extra_title_excludes`. |

## 14. Adapting it to other roles or countries

The tool is built for **QA / SDET / testing roles in India**:

- **Roles:** the title filter, skill vocabulary and scoring are tuned for testing roles.
  - `extra_title_keywords` in `search.yaml` lets in other titles.
  - Good scores for other fields need their skills added to `src/engine/skills.ts`.
- **Countries:** the location filter (Indian cities, remote-open-to-India) lives in `src/engine/filters.ts`, and
  the CTC answers assume rupees.

Both are plain lists in the code if you want to adapt them.

## Optional: more jobs (Adzuna)

Adzuna is a free job aggregator with an official API that covers India, including on-site roles in every city.

1. Register at <https://developer.adzuna.com/>.
2. Copy your **Application ID** and **Application Key**.
3. Copy `.env.example` to `.env`, and fill in:

   ```
   ADZUNA_APP_ID=your_id
   ADZUNA_APP_KEY=your_key
   ```

## Optional: AI answers (Anthropic)

Without a key, everything above works with built-in rules. With an Anthropic API key, Claude:

- reads your resume more thoroughly
- scores jobs more precisely
- drafts answers to open questions, using only facts from your resume and profile, marked for your review

Paid per use: a batch costs cents.

1. Create a key at <https://console.anthropic.com> (add a few dollars of credit under Billing).
2. Add `ANTHROPIC_API_KEY=...` to `.env`.
3. Run `npm run cli -- score --rescore`.

## 15. For developers

```bash
npm test           # all tests (offline; they never call any paid API)
npm run typecheck
```

The browser tests drive a headless Chrome against local fixture forms in `tests/fixtures/`. They never touch a
real job site.

```text
src/
  cli.ts              commands
  config.ts           .env and YAML config (creates your config from the *.example.yaml files)
  db.ts               SQLite store (data/jobs.db), Node's built-in node:sqlite
  engine/             resume parsing, filters, scoring, reports, the fetch pipeline, skill vocabulary
  sources/            Greenhouse, Lever, Ashby, Himalayas, Remotive, Adzuna
  apply/              form reading, answer rules, filling, apply sessions, batches, browser
  web/                dashboard server and page
config/               *.example.yaml (committed); your own profile.yaml / search.yaml (ignored)
tests/                vitest suites and fixture forms
```

**Privacy:** `resume/`, `data/`, `reports/`, `browser-profile/`, `.env`, `config/profile.yaml` and
`config/search.yaml` are all in `.gitignore`.

## License

[MIT](LICENSE): free to use, copy, modify and share, including commercially, as long as the license notice is
kept. Provided as is, without warranty.
