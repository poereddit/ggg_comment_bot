# ggg-comment-bot (Devvit)

When a Path of Exile employee comments in a thread, this app keeps one stickied comment at the top of the thread listing every employee reply, each with a link and a short snippet. It is a port of the Python bot in [poereddit/ggg_comment_bot](https://github.com/poereddit/ggg_comment_bot), which stops working when Reddit's public API closes.

## Status

Playtested on Devvit 0.15.2 in a private test subreddit. Verified there: a roster member's comment creates the stickied summary from the app account, later comments edit it, the app's own comments are skipped, and the cron sweep back-fills comments the trigger missed.

Not yet checked: a real GGG account (only a test account was on the roster), chaining past the 7,200 character limit on a live thread, and what happens when a thread's summary is deleted by a mod.

Devvit notes learned on the way:
- Use `devvit` and `@devvit/web` at the same version. 0.14.2 pulled in a second copy of `@devvit/server`, which broke every trigger with "No context found".
- In the `onCommentCreate` payload, `comment.author` is a user id (`t2_...`). The username is `event.author.name`.
- Trigger endpoints must answer with a `Content-Length` header.
- A roster name with no Reddit account is logged and skipped by the sweep.

## How it works

- `onCommentCreate` checks the author against the roster and, for employees, adds a line to the thread's summary comment.
- A sweep every 10 minutes reads each roster member's recent comments in this subreddit and adds anything the trigger missed. It ignores comments older than a day, so installing the app never touches old threads.
- Once the summary comment passes 7,200 characters it gets the footer, and further lines go in a distinguished reply to it.
- A comment is marked as handled only after Reddit accepts the edit, so a failure is picked up again by the next sweep.
- A short Redis lock per thread stops two comments that arrive together from overwriting each other.
- The roster is a per-subreddit setting (one username per line). Mods can edit it without a redeploy.

## Differences from the Python bot

- Comments come from the app's account, not u/GGGCommentBot. Existing summary comments stay under the old account and are not edited.
- Roster matching ignores case.
- No first-run baseline. The one-day limit on the sweep does that job.

## Run the checks

```
npm install
npm test
```
